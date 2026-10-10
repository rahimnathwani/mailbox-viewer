// Embed text chunks with the transformers.js model the viewer uses for queries, so document and
// query vectors match. Vectors are unit length, stored as int8 (x127), row-major.
//
//   node embed.mjs --in chunks.jsonl --out vectors.bin --config search-config.json --cache ~/.cache/mailbox-viewer/embeddings
//
// chunks.jsonl: one JSON string per line. A content-addressed cache makes rebuilds cheap.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

if (!isMainThread) {
  const { model, dtype, pooling, threads, cacheDir } = workerData;
  env.cacheDir = cacheDir;
  const extract = await pipeline("feature-extraction", model, {
    dtype, session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  });
  parentPort.on("message", async ({ b, texts }) => {
    const out = await extract(texts, { pooling, normalize: true });
    parentPort.postMessage({ b, data: out.data }, [out.data.buffer]);
  });
  parentPort.postMessage({ ready: true });
} else {
await main();
}

async function main() {
  const { values: args } = parseArgs({
    options: { in: { type: "string" }, out: { type: "string" }, config: { type: "string" }, cache: { type: "string" },
      batch: { type: "string", default: "8" }, workers: { type: "string", default: "" } },
  });
  const cfg = JSON.parse(readFileSync(args.config, "utf8")).embedding;
  env.cacheDir = process.env.MBV_MODEL_CACHE || join(dirname(args.cache), "models");  // keep model downloads with the other caches
  const dims = cfg.dims;
  const texts = readFileSync(args.in, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hash = (t) => createHash("sha1").update(t).digest("hex");
  const keys = texts.map(hash);

  // Cache: segments of keys-<id>.txt (one sha1 per line) + vectors-<id>.bin (int8 rows, same order).
  // Each run appends only to its own segment, so concurrent builds never clobber each other; a torn
  // segment (interrupted run) is read up to its last complete row.
  const cacheDir = join(args.cache, `${cfg.model.replace(/\W+/g, "_")}-${cfg.dtype}-${cfg.pooling}`);
  mkdirSync(cacheDir, { recursive: true });
  const segId = `${Date.now().toString(36)}-${process.pid}`;
  const keyFile = join(cacheDir, `keys-${segId}.txt`), vecFile = join(cacheDir, `vectors-${segId}.bin`);
  const parts = [];
  const row = new Map();
  let cacheRows = 0;
  for (const f of readdirSync(cacheDir).filter((f) => /^keys(-.+)?\.txt$/.test(f)).sort()) {
    const vf = join(cacheDir, f.replace(/^keys/, "vectors").replace(/\.txt$/, ".bin"));
    if (!existsSync(vf)) continue;
    const ks = readFileSync(join(cacheDir, f), "utf8").split("\n").filter((k) => k.length === 40);
    const vs = readFileSync(vf);
    const n = Math.min(ks.length, Math.floor(vs.length / dims));
    parts.push(vs.subarray(0, n * dims));
    for (let i = 0; i < n; i++) if (!row.has(ks[i])) row.set(ks[i], cacheRows + i);
    cacheRows += n;
  }
  let cacheVecs = Buffer.concat(parts);

  const todo = [];
  const seen = new Set();
  texts.forEach((t, i) => { if (!row.has(keys[i]) && !seen.has(keys[i])) { seen.add(keys[i]); todo.push(i); } });
  console.error(`embedding ${todo.length.toLocaleString()} new chunks (${(new Set(keys).size - todo.length).toLocaleString()} cached) with ${cfg.model} (${cfg.dtype})`);

  if (todo.length) {
    // Several worker threads, each with its own ONNX session, beat one session using every core; batches of
    // similar-length texts waste less time on padding. (M1 Max: 49/s → ~100/s.)
    const cpus = availableParallelism();
    const W = Math.max(1, Math.min(Number(args.workers) || Math.floor(cpus / 2), 8));
    const threads = Math.max(1, Math.floor(cpus / W));
    const B = Math.max(1, Number(args.batch) || 8);
    todo.sort((a, b) => texts[a].length - texts[b].length);
    const batches = [];
    for (let s = 0; s < todo.length; s += B) batches.push(todo.slice(s, s + B));
    console.error(`  ${W} workers x ${threads} threads`);
    const t0 = Date.now();
    const fresh = [];
    let next = 0, done = 0, lastLog = 0;
    await new Promise((resolve, reject) => {
      let live = W;
      for (let w = 0; w < W; w++) {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { model: cfg.model, dtype: cfg.dtype, pooling: cfg.pooling, threads, cacheDir: env.cacheDir },
        });
        const feed = () => {
          if (next < batches.length) { const b = next++; worker.postMessage({ b, texts: batches[b].map((i) => texts[i]) }); }
          else { worker.terminate(); if (--live === 0) resolve(); }
        };
        worker.on("error", reject);
        worker.on("message", (m) => {
          if (m.ready) return feed();
          const idx = batches[m.b];
          const bin = Buffer.alloc(idx.length * dims);
          for (let j = 0; j < bin.length; j++) bin.writeInt8(Math.max(-127, Math.min(127, Math.round(m.data[j] * 127))), j);
          appendFileSync(vecFile, bin);
          appendFileSync(keyFile, idx.map((i) => keys[i]).join("\n") + "\n");
          fresh.push(bin);
          idx.forEach((i) => row.set(keys[i], cacheRows++));
          done += idx.length;
          if (Date.now() - lastLog > 5000 || done === todo.length) {
            lastLog = Date.now();
            const rate = done / ((Date.now() - t0) / 1000);
            console.error(`  ${done.toLocaleString()}/${todo.length.toLocaleString()}  ${rate.toFixed(0)}/s`);
          }
          feed();
        });
      }
    });
    cacheVecs = Buffer.concat([cacheVecs, ...fresh]);
  }

  const outBuf = Buffer.alloc(texts.length * dims);
  keys.forEach((k, i) => { const r = row.get(k); cacheVecs.copy(outBuf, i * dims, r * dims, (r + 1) * dims); });
  writeFileSync(args.out, outBuf);
  console.error(`wrote ${texts.length.toLocaleString()} x ${dims} vectors (${(outBuf.length / 1e6).toFixed(1)} MB)`);
}
