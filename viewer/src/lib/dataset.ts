import { connect, exec, query, sqlString } from "./db";
import { site } from "./site";
import type { Addr, AttMeta, Body, DatasetEntry, Manifest, Message, Thread } from "./types";

/** Where datasets live: VITE_DATA_URL (the R2 bucket's public URL) or /data for local preview. */
export const DATA_URL = (import.meta.env.VITE_DATA_URL || site("data")).replace(/\/+$/, "");
export const dataBase = () => new URL(`${DATA_URL}/`, location.href).href;

export async function listDatasets(): Promise<DatasetEntry[]> {
  const r = await fetch(`${dataBase()}datasets.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`datasets.json: HTTP ${r.status}`);
  return (await r.json()).datasets;
}

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class Dataset {
  readonly base: string;
  readonly table: string;
  manifest!: Manifest;
  threads: Thread[] = [];
  byId = new Map<string, Thread>();
  /** doc → index into threads */
  docThread!: Int32Array;
  /** doc → BM25 length */
  docLen!: Float32Array;
  labels = new Set<string>();

  private constructor(readonly slug: string) {
    this.base = `${dataBase() + encodeURIComponent(slug)}/`;
    this.table = `m_${slug.replace(/\W/g, "_")}`;
  }

  static async open(slug: string, onStep?: (s: string) => void): Promise<Dataset> {
    const ds = new Dataset(slug);
    onStep?.("Loading mailbox");
    const r = await fetch(`${ds.base}manifest.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status === 404 ? `No mailbox called "${slug}"` : `manifest.json: HTTP ${r.status}`);
    ds.manifest = await r.json();
    onStep?.("Starting database");
    await connect();
    onStep?.("Loading conversations");
    await ds.loadThreads();
    ds.docThread = new Int32Array(ds.manifest.counts.messages).fill(-1);
    ds.threads.forEach((t, i) => {
      for (const d of t.docs) ds.docThread[d] = i;
    });
    // the per-message table is only needed for search and conversations: load it after first paint
    ds.ready = ds.loadMessages();
    ds.ready.catch(() => {});
    return ds;
  }

  /** Resolves when the in-memory messages table (search filters, BM25 lengths) is loaded. */
  ready!: Promise<void>;

  private async loadMessages() {
    // parquet is columnar: DuckDB downloads only these columns' byte ranges. Columns added in later
    // versions are optional, so a newer viewer still opens mailboxes built earlier.
    const src = `read_parquet(${sqlString(this.url("messages"))})`;
    const have = new Set(
      (await query<{ column_name: string }>(`DESCRIBE SELECT * FROM ${src}`)).map((c) => c.column_name),
    );
    const optional: Record<string, string> = { att_names: "lower(att_json)" };
    const cols = [
      "doc",
      "id",
      "thread_id",
      "ts",
      "from_name",
      "from_addr",
      "to_json",
      "cc_json",
      "bcc_json",
      "subject",
      "labels",
      "att_json",
      "att_names",
      "att_count",
      "has_att",
      "size",
      "doclen",
    ].map((c) => (have.has(c) ? c : `${optional[c] ?? "NULL"} AS ${c}`));
    await exec(`CREATE OR REPLACE TABLE ${this.table} AS SELECT ${cols.join(", ")} FROM ${src}`);
    const meta = await query<{ doc: number; doclen: number }>(`SELECT doc, doclen FROM ${this.table} ORDER BY doc`);
    this.docLen = new Float32Array(this.manifest.counts.messages);
    for (const m of meta) this.docLen[m.doc] = m.doclen;
  }

  private async loadThreads() {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM read_parquet(${sqlString(this.url("threads"))}) ORDER BY last_ts DESC NULLS LAST`,
    );
    this.threads = rows.map((r) => ({
      thread_id: r.thread_id as string,
      subject: (r.subject as string) || "",
      first_ts: (r.first_ts as number) ?? null,
      last_ts: (r.last_ts as number) ?? null,
      count: r.count as number,
      senders: json<Addr[]>(r.senders_json, []),
      recipients: json<Addr[]>(r.recipients_json, []),
      snippet: (r.snippet as string) || "",
      has_att: !!r.has_att,
      atts: json<AttMeta[]>(r.att_json, []),
      att_count: (r.att_count as number) || 0,
      labels: (r.labels as string[]) || [],
      docs: (r.docs as number[]) || [],
    }));
    this.byId = new Map(this.threads.map((t) => [t.thread_id, t]));
    for (const t of this.threads) for (const l of t.labels) this.labels.add(l);
  }

  url(name: string): string {
    const f = this.manifest.files[name];
    if (!f) throw new Error(`dataset has no ${name} file`);
    return this.base + f;
  }

  /** URL for an attachment path from the tables (already percent-encoded). */
  attUrl(path: string): string {
    return this.base + path;
  }

  async messages(threadId: string): Promise<Message[]> {
    await this.ready;
    const rows = await query<Record<string, unknown>>(
      `SELECT doc, id, thread_id, ts, from_name, from_addr, to_json, cc_json, bcc_json, subject,
              labels, att_json, att_count, size
       FROM ${this.table} WHERE thread_id = ? ORDER BY ts NULLS FIRST, doc DESC`,
      [threadId],
    );
    return rows.map((r) => ({
      doc: r.doc as number,
      id: r.id as string,
      thread_id: r.thread_id as string,
      ts: (r.ts as number) ?? null,
      from_name: (r.from_name as string) || "",
      from_addr: (r.from_addr as string) || "",
      to: json<Addr[]>(r.to_json, []),
      cc: json<Addr[]>(r.cc_json, []),
      bcc: json<Addr[]>(r.bcc_json, []),
      subject: (r.subject as string) || "",
      labels: (r.labels as string[]) || [],
      atts: json<AttMeta[]>(r.att_json, []),
      att_count: (r.att_count as number) || 0,
      size: (r.size as number) || 0,
    }));
  }

  /** Bodies for one conversation: the bodies file is sorted by thread, so this reads one row group. */
  async bodies(threadId: string): Promise<Map<number, Body>> {
    const rows = await query<Record<string, unknown>>(
      `SELECT doc, id, message_id, reply_to_json, snippet, text, html, headers
       FROM read_parquet(${sqlString(this.url("bodies"))}) WHERE thread_id = ?`,
      [threadId],
    );
    return new Map(
      rows.map((r) => [
        r.doc as number,
        {
          doc: r.doc as number,
          id: r.id as string,
          message_id: (r.message_id as string) || "",
          reply_to: json<Addr[]>(r.reply_to_json, []),
          snippet: (r.snippet as string) || "",
          text: (r.text as string) || "",
          html: (r.html as string) || null,
          headers: (r.headers as string) || "",
        },
      ]),
    );
  }

  async attachmentText(messageId: string, idx: number): Promise<string> {
    const rows = await query<{ text: string | null }>(
      `SELECT text FROM read_parquet(${sqlString(this.url("attachments"))}) WHERE id = ? AND idx = ?`,
      [messageId, idx],
    );
    return rows[0]?.text || "";
  }

  /** Message docs matching a SQL condition on the in-memory messages table. */
  async docsWhere(where: string, params: unknown[]): Promise<Set<number>> {
    await this.ready;
    const rows = await query<{ doc: number }>(`SELECT doc FROM ${this.table} WHERE ${where}`, params);
    return new Set(rows.map((r) => r.doc));
  }

  threadOfDoc(doc: number): Thread | undefined {
    const i = this.docThread[doc];
    return i >= 0 ? this.threads[i] : undefined;
  }

  hasLabel(name: string): boolean {
    return this.labels.has(name);
  }
}
