// Search = operator filters (SQL over the in-memory messages table)
//        + keyword BM25 (postings.parquet / phrases.parquet read by range requests, only the row groups for the query terms)
//        + semantic similarity (in-browser embeddings), fused by reciprocal rank.

import type { Dataset } from "../dataset";
import { query, sqlString } from "../db";
import type { Thread } from "../types";
import { type Group, type OpClause, parseDate, parseRelative, parseSize, type Query } from "./query";
import type { Semantic, SemHits } from "./semantic";
import { STOPWORDS, tokenize } from "./tokenize.js";

const RRF_K = 60;

export interface SearchResult {
  /** threads with keyword/filter matches, best first (or newest first) */
  threads: Thread[];
  /** threads found only by meaning, shown in their own section */
  similar: Thread[];
  /** docs that matched, to highlight messages inside a thread */
  docs: Set<number>;
  /** words to highlight */
  highlight: string[];
  semantic: "unused" | "off" | "loading" | "ready" | "error";
}

const SYSTEM_IN: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  draft: "Drafts",
  spam: "Spam",
  trash: "Trash",
};
const HAS_EXT: Record<string, string[]> = {
  pdf: [".pdf"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".heic", ".webp"],
  document: [".doc", ".docx", ".odt", ".rtf", ".pages"],
  spreadsheet: [".xls", ".xlsx", ".xlsm", ".csv", ".ods", ".numbers"],
  presentation: [".ppt", ".pptx", ".odp", ".key"],
};

/** SQL condition for operator clauses; is:starred/unread/read are applied later in JS. */
export function opsToSql(ops: OpClause[], ds: Dataset, groups: Group[] = []): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  let scoped = false;
  for (const clause of ops) {
    const r = clauseSql(clause);
    if (r.scoped) scoped = true;
    if (r.c) {
      conds.push(r.c);
      params.push(...r.params);
    }
  }
  // a label named inside a group ({in:spam in:inbox}) also lifts the spam/trash exclusion
  if (groups.some((g) => !g.neg && g.ops.some((c) => clauseSql(c).scoped))) scoped = true;
  if (!scoped && (ds.hasLabel("Spam") || ds.hasLabel("Trash"))) {
    conds.push(`NOT list_has_any(labels, ['Spam', 'Trash'])`);
  }
  return { where: conds.join(" AND "), params };
}

function clauseSql({ op, value, neg }: OpClause): { c: string | null; params: unknown[]; scoped: boolean } {
  const params: unknown[] = [];
  const like = (v: string) => `%${v.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  let scoped = false;
  {
    let c: string | null = null;
    const v = value.trim();
    switch (op) {
      case "from":
        c = `(lower(from_name) LIKE ? ESCAPE '\\' OR lower(from_addr) LIKE ? ESCAPE '\\')`;
        params.push(like(v), like(v));
        break;
      case "to":
        c = `(lower(to_json || cc_json || bcc_json) LIKE ? ESCAPE '\\')`;
        params.push(like(v));
        break;
      case "cc":
      case "bcc":
        c = `(lower(${op}_json) LIKE ? ESCAPE '\\')`;
        params.push(like(v));
        break;
      case "subject": {
        const words = value.split(/\s+/).filter(Boolean);
        c = `(${words.map(() => `lower(subject) LIKE ? ESCAPE '\\'`).join(" AND ")})`;
        params.push(...words.map(like));
        break;
      }
      case "label":
      case "in": {
        const low = v.toLowerCase();
        if (op === "in" && (low === "anywhere" || low === "all")) {
          scoped = !neg;
          break;
        }
        scoped = !neg; // "-label:x" still keeps spam and trash out
        const name = SYSTEM_IN[low] ?? v;
        c = `list_contains(list_transform(labels, x -> lower(replace(x, ' ', '-'))), ?) OR list_contains(list_transform(labels, x -> lower(x)), ?)`;
        params.push(name.toLowerCase().replace(/ /g, "-"), name.toLowerCase());
        c = `(${c})`;
        break;
      }
      case "has": {
        const low = v.toLowerCase();
        if (low === "attachment" || low === "attachments") c = "has_att";
        else if (HAS_EXT[low]) {
          c = `(${HAS_EXT[low].map(() => `lower(att_json) LIKE ? ESCAPE '\\'`).join(" OR ")})`;
          params.push(...HAS_EXT[low].map((e) => like(`${e}"`)));
        } else if (low === "userlabels")
          c = `len(list_filter(labels, x -> x NOT IN ('Inbox','Sent','Drafts','Spam','Trash'))) > 0`;
        break;
      }
      case "filename":
        c = `(att_names LIKE ? ESCAPE '\\')`;
        params.push(like(v));
        break;
      case "before":
      case "older":
      case "after":
      case "newer": {
        const t = parseDate(v);
        if (t != null) {
          c = op === "before" || op === "older" ? "ts < ?" : "ts >= ?";
          params.push(t);
        }
        break;
      }
      case "older_than":
      case "newer_than": {
        const t = parseRelative(v);
        if (t != null) {
          c = op === "older_than" ? "ts < ?" : "ts >= ?";
          params.push(t);
        }
        break;
      }
      case "larger":
      case "size":
      case "smaller": {
        const n = parseSize(v);
        if (n != null) {
          c = op === "smaller" ? "size < ?" : "size >= ?";
          params.push(n);
        }
        break;
      }
      case "is":
        break;
    }
    return { c: c ? (neg ? `NOT ${c}` : c) : null, params, scoped };
  }
}

/** Plural folding: "meeting" also finds "meetings" and vice versa. */
function variants(t: string): string[] {
  if (/\d/.test(t) || t.length < 3) return [t];
  if (t.endsWith("ies") && t.length > 4) return [t, `${t.slice(0, -3)}y`];
  if (t.endsWith("s") && !t.endsWith("ss")) return [t, t.slice(0, -1)];
  if (t.endsWith("y")) return [t, `${t}s`, `${t.slice(0, -1)}ies`];
  return [t, `${t}s`];
}

type Posting = { term: string; doc: number; tf: number };

async function fetchPostings(url: string, groups: string[][]): Promise<Posting[]> {
  groups = groups.filter((g) => g.length);
  if (!groups.length) return [];
  // One scan per word. Plural variants sort next to each other, so IN over them stays inside one row group;
  // a single IN over all words would read every row group between the first and last word.
  const sql = groups
    .map(
      (g) =>
        `SELECT term, doc, tf FROM read_parquet(${sqlString(url)}) WHERE term ${g.length === 1 ? "= ?" : `IN (${g.map(() => "?").join(", ")})`}`,
    )
    .join(" UNION ALL ");
  return query<Posting>(sql, groups.flat());
}

interface KeywordHits {
  scores: Map<number, number>;
  excluded: Set<number>;
  highlight: string[];
  used: boolean;
}

/** Groups of plain one-token words take part in BM25 scoring; anything richer is evaluated as a filter. */
const isSimpleGroup = (g: Group) =>
  !g.neg && !g.ops.length && !g.phrases.length && g.words.length > 0 && g.words.every((w) => tokenize(w).length === 1);

async function keyword(ds: Dataset, q: Query): Promise<KeywordHits> {
  const m = ds.manifest.search;
  const N = m.docs,
    avg = m.avg_len || 1,
    k1 = m.k1,
    b = m.b;
  const idf = (df: number) => Math.log(1 + (N - df + 0.5) / (df + 0.5));

  const groups: string[][] = [];
  const highlight: string[] = [];
  for (const raw of q.terms) {
    for (const t of tokenize(raw)) {
      if (STOPWORDS.has(t)) continue;
      highlight.push(t);
      groups.push(variants(t));
    }
  }
  for (const g of q.groups.filter(isSimpleGroup)) {
    const toks = g.words.map((w) => tokenize(w)[0]);
    highlight.push(...toks.filter((t) => !STOPWORDS.has(t)));
    groups.push([...new Set(toks.flatMap(variants))]);
  }
  for (const g of q.groups.filter((g) => !isSimpleGroup(g) && !g.neg)) {
    for (const w of [...g.words, ...g.phrases]) highlight.push(...tokenize(w).filter((t) => !STOPWORDS.has(t)));
  }
  const phraseBigrams: string[][] = [];
  for (const p of q.phrases) {
    const toks = tokenize(p);
    highlight.push(...toks);
    if (toks.length === 1) groups.push(toks);
    else if (toks.length > 1) phraseBigrams.push(toks.slice(1).map((t, i) => `${toks[i]} ${t}`));
  }
  const notGroups = q.notTerms.flatMap((t) => tokenize(t)).map(variants);
  const notBigrams = q.notPhrases.map((p) => {
    const toks = tokenize(p);
    return toks.length === 1 ? [] : toks.slice(1).map((t, i) => `${toks[i]} ${t}`);
  });
  const notSingles = q.notPhrases
    .map((p) => tokenize(p))
    .filter((t) => t.length === 1)
    .map((t) => [t[0]]);

  const dedupe = (gs: string[][]) => [...new Map(gs.map((g) => [g.join("\u0000"), g])).values()];
  const uniGroups = dedupe([...groups, ...notGroups, ...notSingles]);
  const biGroups = dedupe([...phraseBigrams, ...notBigrams].flat().map((t) => [t]));
  const [uni, bi] = await Promise.all([
    fetchPostings(ds.url("postings"), uniGroups),
    m.phrases ? fetchPostings(ds.url("phrases"), biGroups) : Promise.resolve([]),
  ]);
  const byTerm = new Map<string, Posting[]>();
  for (const p of [...uni, ...bi]) {
    const l = byTerm.get(p.term);
    if (l) l.push(p);
    else byTerm.set(p.term, [p]);
  }
  const groupDocs = (terms: string[]) => {
    const tf = new Map<number, number>();
    for (const t of terms) for (const p of byTerm.get(t) || []) tf.set(p.doc, Math.max(tf.get(p.doc) || 0, p.tf));
    return tf;
  };

  const excluded = new Set<number>();
  for (const g of [...notGroups, ...notSingles]) for (const d of groupDocs(g).keys()) excluded.add(d);
  for (const bigrams of notBigrams) {
    if (!bigrams.length) continue;
    const sets = bigrams.map((bg) => new Set((byTerm.get(bg) || []).map((p) => p.doc)));
    for (const d of sets[0]) if (sets.every((s) => s.has(d))) excluded.add(d);
  }

  const required = [
    ...groups.map(groupDocs),
    ...phraseBigrams.map((bgs) => {
      // a phrase matches when every adjacent word pair occurs; score with the rarest pair
      const sets = bgs.map((bg) => groupDocs([bg]));
      const out = new Map<number, number>();
      for (const [d, tf] of sets[0]) {
        let min = tf;
        if (
          sets.every((s) => {
            const v = s.get(d);
            if (v != null) min = Math.min(min, v);
            return v != null;
          })
        )
          out.set(d, min * 2);
      }
      return out;
    }),
  ];
  const scores = new Map<number, number>();
  if (!required.length) return { scores, excluded, highlight, used: false };
  required.sort((a, b) => a.size - b.size);
  for (const [d] of required[0]) {
    if (!required.every((g) => g.has(d))) continue;
    let s = 0;
    const norm = k1 * (1 - b + (b * (ds.docLen[d] || avg)) / avg);
    for (const g of required) {
      const tf = g.get(d)!;
      s += idf(g.size) * ((tf * (k1 + 1)) / (tf + norm));
    }
    scores.set(d, s);
  }
  return { scores, excluded, highlight, used: true };
}

/** Messages matching any item of a group: operator clauses, is:, words (all their tokens), phrases. */
async function groupDocs(ds: Dataset, g: Group, st: ThreadFilter): Promise<Set<number>> {
  const out = new Set<number>();
  const sql = g.ops
    .filter((c) => c.op !== "is")
    .map(clauseSql)
    .filter((r) => r.c);
  if (sql.length)
    for (const d of await ds.docsWhere(
      sql.map((r) => r.c).join(" OR "),
      sql.flatMap((r) => r.params),
    ))
      out.add(d);
  for (const c of g.ops) {
    const f = c.op === "is" ? isTest(c.value, st) : null;
    if (!f) continue;
    for (const t of ds.threads) if (f(t) !== c.neg) for (const d of t.docs) out.add(d);
  }
  const all = (sets: Set<number>[]) => (sets.length ? [...sets[0]].filter((d) => sets.every((s) => s.has(d))) : []);
  const docsOf = (rows: Posting[], terms: string[][]) =>
    terms.map((alts) => new Set(rows.filter((r) => alts.includes(r.term)).map((r) => r.doc)));
  for (const w of g.words) {
    const toks = tokenize(w).filter((t) => !STOPWORDS.has(t));
    if (!toks.length) continue;
    const terms = toks.length === 1 ? [variants(toks[0])] : toks.map((t) => [t]);
    for (const d of all(docsOf(await fetchPostings(ds.url("postings"), terms), terms))) out.add(d);
  }
  for (const p of g.phrases) {
    const toks = tokenize(p);
    if (!toks.length) continue;
    const [url, terms] =
      toks.length === 1
        ? [ds.url("postings"), [[toks[0]]]]
        : [ds.url("phrases"), toks.slice(1).map((t, i) => [`${toks[i]} ${t}`])];
    for (const d of all(docsOf(await fetchPostings(url, terms), terms))) out.add(d);
  }
  return out;
}

export interface ThreadFilter {
  starred: (t: Thread) => boolean;
  unread: (t: Thread) => boolean;
}

export async function search(
  ds: Dataset,
  q: Query,
  opts: { semantic: Semantic | null; sort: "relevance" | "date"; state: ThreadFilter },
): Promise<SearchResult> {
  await ds.ready;
  const { where, params } = opsToSql(q.ops, ds, q.groups);
  const filterP = where ? ds.docsWhere(where, params) : Promise.resolve(null);
  const hasText = q.terms.length + q.phrases.length + q.groups.filter(isSimpleGroup).length > 0;
  const complex = q.groups.filter((g) => !isSimpleGroup(g));
  const groupsP = Promise.all(complex.map((g) => groupDocs(ds, g, opts.state)));
  const kwP =
    hasText || q.notTerms.length || q.notPhrases.length
      ? keyword(ds, q)
      : Promise.resolve<KeywordHits>({ scores: new Map(), excluded: new Set(), highlight: [], used: false });

  const sem = opts.semantic;
  let semState: SearchResult["semantic"] = "unused";
  let semP: Promise<SemHits> = Promise.resolve({ hits: [], median: 0 });
  if (hasText && q.text) {
    if (!sem) semState = "off";
    else {
      semState = sem.state === "ready" ? "ready" : sem.state === "error" ? "error" : "loading";
      if (sem.state === "ready") semP = sem.search(q.text, 300).catch(() => ({ hits: [], median: 0 }));
    }
  }
  const [filter, kw, semHits, groupSets] = await Promise.all([filterP, kwP, semP, groupsP]);
  const allowed = (d: number) =>
    (!filter || filter.has(d)) && !kw.excluded.has(d) && complex.every((g, i) => groupSets[i].has(d) !== g.neg);

  // ----- no free text: operator filter, newest first -----
  if (!hasText) {
    const docs = new Set<number>();
    const seen = new Set<number>();
    const threads: Thread[] = [];
    const all = filter ?? new Set(Array.from({ length: ds.docThread.length }, (_, i) => i));
    for (const d of all) {
      if (!allowed(d)) continue;
      docs.add(d);
      const ti = ds.docThread[d];
      if (ti >= 0 && !seen.has(ti)) {
        seen.add(ti);
        threads.push(ds.threads[ti]);
      }
    }
    threads.sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0));
    return { threads: applyIs(threads, q, opts.state), similar: [], docs, highlight: [], semantic: semState };
  }

  // ----- fuse keyword + semantic ranks per doc, then per thread -----
  const kwRanked = [...kw.scores.entries()].filter(([d]) => allowed(d)).sort((a, b) => b[1] - a[1]);
  // Similarities from small embedding models are compressed (unrelated text still scores ~0.45), so the
  // cutoff adapts per query: well above this query's median, close to its best hit, above a model floor.
  const top = semHits.hits.length ? semHits.hits[0][1] : 0;
  const cutoff = Math.max(ds.manifest.embedding?.min_score ?? 0.5, semHits.median + 0.06, top - 0.05);
  const semKept = semHits.hits.filter(([d, s]) => s >= cutoff && allowed(d)).slice(0, 40);

  const docScore = new Map<number, number>();
  const fuse = (ranked: [number, number][], weight: number) => {
    ranked.forEach(([d], r) => {
      docScore.set(d, (docScore.get(d) || 0) + weight / (RRF_K + r));
    });
  };
  fuse(kwRanked, 1);
  fuse(semKept, 0.8);
  const kwDocs = new Set(kwRanked.map(([d]) => d));

  const exact = new Map<number, number>(),
    similar = new Map<number, number>();
  for (const [d, s] of docScore) {
    const ti = ds.docThread[d];
    if (ti < 0) continue;
    const target = kwDocs.has(d) ? exact : similar;
    target.set(ti, Math.max(target.get(ti) || 0, s));
  }
  for (const ti of exact.keys()) similar.delete(ti);

  const order = (m: Map<number, number>) => {
    const list = [...m.entries()];
    if (opts.sort === "date") list.sort((a, b) => (ds.threads[b[0]].last_ts ?? 0) - (ds.threads[a[0]].last_ts ?? 0));
    else list.sort((a, b) => b[1] - a[1]);
    return list.map(([ti]) => ds.threads[ti]);
  };
  return {
    threads: applyIs(order(exact), q, opts.state),
    similar: applyIs(order(similar), q, opts.state),
    docs: new Set(docScore.keys()),
    highlight: kw.highlight,
    semantic: semState,
  };
}

function isTest(value: string, st: ThreadFilter): ((t: Thread) => boolean) | null {
  const v = value.toLowerCase();
  return v === "starred" ? st.starred : v === "unread" ? st.unread : v === "read" ? (t: Thread) => !st.unread(t) : null;
}

function applyIs(threads: Thread[], q: Query, st: ThreadFilter): Thread[] {
  let out = threads;
  for (const { op, value, neg } of q.ops) {
    const test = op === "is" ? isTest(value, st) : null;
    if (test) out = out.filter((t) => test(t) !== neg);
  }
  return out;
}
