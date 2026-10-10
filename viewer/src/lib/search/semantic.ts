import type { Dataset } from "../dataset";
import { query, sqlString } from "../db";
import { siteUrl } from "../site";

export type SemState = "idle" | "loading" | "ready" | "error";
/** [doc, cosine] best chunk per message, plus the median over all messages */
export interface SemHits {
  hits: [number, number][];
  median: number;
}

/** Smart search: loads the embedding model (≈23 MB, cached by the browser) and vectors on demand. */
export class Semantic {
  state: SemState = "idle";
  progress = 0;
  error = "";
  private worker: Worker | null = null;
  private pending = new Map<number, (r: SemHits) => void>();
  private seq = 0;
  private listeners = new Set<() => void>();
  private ready: Promise<void> | null = null;

  constructor(private ds: Dataset) {}

  get available(): boolean {
    return !!this.ds.manifest.embedding && !!this.ds.manifest.files.vectors;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const f of this.listeners) f();
  }

  load(): Promise<void> {
    if (!this.available) return Promise.reject(new Error("no vectors in this dataset"));
    this.ready ??= new Promise<void>((resolve, reject) => {
      this.state = "loading";
      this.emit();
      const emb = this.ds.manifest.embedding!;
      const w = new Worker(new URL("./semantic.worker.ts", import.meta.url), { type: "module" });
      this.worker = w;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === "progress") {
          this.progress = m.pct;
          this.emit();
        } else if (m.type === "ready") {
          this.state = "ready";
          this.emit();
          resolve();
        } else if (m.type === "error") {
          this.state = "error";
          this.error = m.message;
          this.ready = null;
          this.emit();
          reject(new Error(m.message));
        } else if (m.type === "result") {
          this.pending.get(m.id)?.({ hits: m.hits, median: m.median });
          this.pending.delete(m.id);
        }
      };
      query<{ doc: number }>(`SELECT doc FROM read_parquet(${sqlString(this.ds.url("chunks"))})`)
        .then((rows) => {
          const docs = Int32Array.from(rows, (r) => r.doc);
          w.postMessage(
            {
              type: "init",
              model: emb.model,
              dtype: emb.dtype,
              pooling: emb.pooling,
              prefix: emb.query_prefix,
              dims: emb.dims,
              vectorsUrl: this.ds.url("vectors"),
              docs,
              nDocs: this.ds.manifest.counts.messages,
              modelHost: import.meta.env.VITE_SELF_HOST_MODEL === emb.model ? siteUrl("models/") : null,
            },
            [docs.buffer],
          );
        })
        .catch((err) => {
          this.state = "error";
          this.error = String(err);
          this.ready = null;
          this.emit();
          reject(err);
        });
    });
    return this.ready;
  }

  search(text: string, k = 300): Promise<SemHits> {
    if (this.state !== "ready" || !this.worker) return Promise.resolve({ hits: [], median: 0 });
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage({ type: "search", id, text, k });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
