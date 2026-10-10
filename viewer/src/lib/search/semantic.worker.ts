// Embeds queries with the same model the build used for documents, then scores every chunk vector.
/// <reference lib="webworker" />

type Init = {
  type: "init";
  model: string;
  dtype: string;
  pooling: string;
  prefix: string;
  dims: number;
  vectorsUrl: string;
  docs: Int32Array;
  nDocs: number;
  modelHost: string | null;
};
type Search = { type: "search"; id: number; text: string; k: number };

let extract: ((text: string, opts: object) => Promise<{ data: Float32Array }>) | null = null;
let vec: Int8Array,
  docs: Int32Array,
  dims = 0,
  nDocs = 0,
  prefix = "",
  pooling = "cls";

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<Init | Search>) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      if (m.modelHost) {
        // self-hosted: model files under /models/, ONNX runtime under /ort/ instead of huggingface.co and jsDelivr
        env.remoteHost = m.modelHost;
        const paths = env.backends.onnx?.wasm?.wasmPaths as { mjs?: string; wasm?: string } | undefined;
        const local = new URL("../ort/", m.modelHost).href; // siblings under the same base path
        if (paths && typeof paths === "object") {
          for (const k of ["mjs", "wasm"] as const)
            if (paths[k])
              paths[k] = paths[k]!.replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\//, local);
        }
      }
      const files: Record<string, [number, number]> = {};
      const [p, buf] = await Promise.all([
        pipeline("feature-extraction", m.model, {
          dtype: m.dtype as "q8",
          progress_callback: (ev: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (ev.status !== "progress" || !ev.total || !ev.file) return;
            files[ev.file] = [ev.loaded || 0, ev.total];
            const v = Object.values(files);
            post({
              type: "progress",
              pct: Math.round((100 * v.reduce((a, x) => a + x[0], 0)) / v.reduce((a, x) => a + x[1], 0)),
            });
          },
        }),
        fetch(m.vectorsUrl).then((r) => {
          if (!r.ok) throw new Error(`vectors: HTTP ${r.status}`);
          return r.arrayBuffer();
        }),
      ]);
      extract = p as unknown as typeof extract;
      vec = new Int8Array(buf);
      docs = m.docs;
      dims = m.dims;
      nDocs = m.nDocs;
      prefix = m.prefix;
      pooling = m.pooling;
      if (vec.length !== docs.length * dims) throw new Error("vectors and chunk table disagree");
      post({ type: "ready" });
    } catch (err) {
      post({ type: "error", message: String(err) });
    }
  } else if (m.type === "search") {
    try {
      const out = await extract!(prefix + m.text, { pooling, normalize: true });
      const q = out.data;
      const best = new Float32Array(nDocs).fill(-2);
      for (let r = 0, o = 0; r < docs.length; r++, o += dims) {
        let s = 0;
        for (let k = 0; k < dims; k++) s += q[k] * vec[o + k];
        s /= 127;
        const d = docs[r];
        if (s > best[d]) best[d] = s;
      }
      const hits: [number, number][] = [];
      for (let d = 0; d < nDocs; d++) if (best[d] > -2) hits.push([d, best[d]]);
      hits.sort((a, b) => b[1] - a[1]);
      const median = hits.length ? hits[Math.floor(hits.length / 2)][1] : 0;
      post({ type: "result", id: m.id, hits: hits.slice(0, m.k), median });
    } catch (err) {
      post({ type: "result", id: m.id, hits: [], median: 0, error: String(err) });
    }
  }
};
