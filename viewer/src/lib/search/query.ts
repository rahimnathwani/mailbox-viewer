// Gmail-style search syntax: words, "exact phrases", -negation and operators such as
// from: to: cc: bcc: subject: label: in: is: has: filename: before: after: older_than: newer_than: larger: smaller:

export const OPERATORS = [
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "label",
  "in",
  "is",
  "has",
  "filename",
  "before",
  "after",
  "older",
  "newer",
  "older_than",
  "newer_than",
  "larger",
  "smaller",
  "size",
] as const;
export type Op = (typeof OPERATORS)[number];

export interface OpClause {
  op: Op;
  value: string;
  neg: boolean;
}
export interface Group {
  neg: boolean;
  ops: OpClause[];
  words: string[];
  phrases: string[];
}
export interface Query {
  raw: string;
  terms: string[];
  phrases: string[];
  notTerms: string[];
  notPhrases: string[];
  ops: OpClause[];
  /** Gmail's {a b} and `a OR b`: a message matches if any item does (neg: if none does) */
  groups: Group[];
  /** free text without operators, for semantic search */
  text: string;
}

const OP_SET = new Set<string>(OPERATORS);

function lex(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let tok = "";
    if (s[i] === "{" || (s[i] === "-" && s[i + 1] === "{")) {
      const end = s.indexOf("}", i);
      const stop = end < 0 ? s.length : end;
      out.push(s.slice(i, stop + 1));
      i = stop + 1;
      continue;
    }
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === '"' || c === "“" || c === "”") {
        const close = s.slice(i + 1).search(/["“”]/);
        const end = close < 0 ? s.length : i + 1 + close;
        tok += `"${s.slice(i + 1, end)}"`;
        i = end + 1;
      } else if (c === "(" && /:$/.test(tok)) {
        const end = s.indexOf(")", i);
        const stop = end < 0 ? s.length : end;
        tok += `(${s.slice(i + 1, stop)})`;
        i = stop + 1;
      } else {
        tok += c;
        i++;
      }
    }
    if (tok) out.push(tok);
  }
  return out;
}

const unwrap = (v: string) => v.replace(/^["(]|[")]$/g, "").trim();

const isOr = (t: string | undefined) => t === "OR" || t === "|";

export function parseQuery(raw: string): Query {
  const q: Query = { raw, terms: [], phrases: [], notTerms: [], notPhrases: [], ops: [], groups: [], text: "" };
  const free: string[] = [];
  const toks = lex(raw);
  // `a OR b OR c` → {a b c}; works for words, phrases, operators and groups. Negated items stay outside.
  for (let i = 1; i < toks.length - 1; i++) {
    if (
      !isOr(toks[i]) ||
      isOr(toks[i - 1]) ||
      isOr(toks[i + 1]) ||
      toks[i - 1].startsWith("-") ||
      toks[i + 1].startsWith("-")
    )
      continue;
    const items = [toks[i - 1], toks[i + 1]];
    let j = i + 2;
    while (isOr(toks[j]) && toks[j + 1] && !toks[j + 1].startsWith("-") && !isOr(toks[j + 1])) {
      items.push(toks[j + 1]);
      j += 2;
    }
    toks.splice(i - 1, j - i + 1, `{${items.map((t) => (t.startsWith("{") ? t.slice(1, -1) : t)).join(" ")}}`);
  }
  for (let tok of toks) {
    if (tok.startsWith("{") || tok.startsWith("-{")) {
      const neg = tok.startsWith("-");
      const inner = parseQuery(tok.replace(/^-?\{|\}$/g, ""));
      const g: Group = { neg, ops: inner.ops.filter((o) => !o.neg), words: inner.terms, phrases: inner.phrases };
      for (const ig of inner.groups)
        if (!ig.neg) {
          g.ops.push(...ig.ops);
          g.words.push(...ig.words);
          g.phrases.push(...ig.phrases);
        }
      // exclusions written inside a group apply to the whole search
      q.notTerms.push(...inner.notTerms);
      q.notPhrases.push(...inner.notPhrases);
      q.ops.push(...inner.ops.filter((o) => o.neg));
      if (g.ops.length + g.words.length + g.phrases.length) q.groups.push(g);
      if (!neg) free.push(...g.words, ...g.phrases);
      continue;
    }
    let neg = false;
    if (tok.length > 1 && tok.startsWith("-")) {
      neg = true;
      tok = tok.slice(1);
    }
    const m = /^([a-z_]+):(.+)$/i.exec(tok);
    if (m && OP_SET.has(m[1].toLowerCase())) {
      const value = unwrap(m[2]);
      if (value) q.ops.push({ op: m[1].toLowerCase() as Op, value, neg });
      continue;
    }
    if (tok.startsWith('"')) {
      const p = unwrap(tok);
      if (!p) continue;
      (neg ? q.notPhrases : q.phrases).push(p);
      if (!neg) free.push(p);
      continue;
    }
    if (isOr(tok) || tok === "AND") continue;
    (neg ? q.notTerms : q.terms).push(tok);
    if (!neg) free.push(tok);
  }
  q.text = free.join(" ").trim();
  return q;
}

export function groupToString(g: Group): string {
  const items = [...g.ops.map((c) => op(c.op, c.value, c.neg)), ...g.words, ...g.phrases.map((p) => `"${p}"`)];
  return `${g.neg ? "-" : ""}{${items.join(" ")}}`;
}

const quoteIfNeeded = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function op(name: Op, value: string, neg = false): string {
  return `${neg ? "-" : ""}${name}:${quoteIfNeeded(value)}`;
}

/** Replace (or remove, with value null) every clause of one operator in a query string. */
export function setOp(raw: string, name: Op, value: string | null): string {
  const q = parseQuery(raw);
  const keep = q.ops.filter((c) => c.op !== name).map((c) => op(c.op, c.value, c.neg));
  const parts = [
    ...q.terms,
    ...q.phrases.map((p) => `"${p}"`),
    ...q.notTerms.map((t) => `-${t}`),
    ...q.notPhrases.map((p) => `-"${p}"`),
    ...q.groups.map(groupToString),
    ...keep,
  ];
  if (value !== null) parts.push(op(name, value));
  return parts.join(" ");
}

export function hasFreeText(q: Query): boolean {
  return (
    q.terms.length + q.phrases.length + q.groups.filter((g) => !g.neg && g.words.length + g.phrases.length).length > 0
  );
}

// ---------- operator values ----------

export function parseDate(v: string): number | null {
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]).getTime();
  m = /^(\d{4})$/.exec(v);
  if (m) return new Date(+m[1], 0, 1).getTime();
  if (/^\d{9,11}$/.test(v)) return +v * 1000;
  return null;
}

export function parseRelative(v: string, now = Date.now()): number | null {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return null;
  const n = +m[1],
    d = new Date(now);
  if (m[2].toLowerCase() === "d") d.setDate(d.getDate() - n);
  else if (m[2].toLowerCase() === "m") d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d.getTime();
}

export function parseSize(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(v);
  if (!m) return null;
  return Math.round(
    +m[1] * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[m[2].toLowerCase()],
  );
}
