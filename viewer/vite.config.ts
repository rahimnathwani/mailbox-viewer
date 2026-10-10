import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import sirv from "sirv";
import { defineConfig, type Plugin } from "vite";

// `npm run dev` serves ../dist at /data (with Range support), like `mbv preview` does.
const localData = (): Plugin => ({
  name: "mbv-local-data",
  configureServer(server) {
    const dist = fileURLToPath(new URL("../dist", import.meta.url));
    const serve = sirv(dist, { dev: true, etag: true });
    server.middlewares.use("/data", (req, res, next) => serve(req, res, next));
  },
});

// VITE_SELF_HOST=1: DuckDB-WASM loads its parquet extension from extensions.duckdb.org at runtime;
// copy the matching signed binaries into the build so the site makes no third-party requests.
const duckdbExtensions = (): Plugin => ({
  name: "mbv-duckdb-extensions",
  apply: "build",
  async writeBundle(options) {
    if (process.env.VITE_SELF_HOST !== "1") return;
    const require = createRequire(import.meta.url);
    const dist = dirname(require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"));
    const duckdb = require(join(dist, "duckdb-node-blocking.cjs"));
    const db = await duckdb.createDuckDB(
      {
        mvp: { mainModule: join(dist, "duckdb-mvp.wasm"), mainWorker: "" },
        eh: { mainModule: join(dist, "duckdb-eh.wasm"), mainWorker: "" },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    const version: string = db.connect().query("SELECT version() v").toArray()[0].v;
    const cache = fileURLToPath(new URL("node_modules/.cache/duckdb-extensions/", import.meta.url));
    for (const platform of ["wasm_eh", "wasm_mvp"]) {
      const rel = `${version}/${platform}/parquet.duckdb_extension.wasm`;
      const cached = join(cache, rel);
      if (!existsSync(cached)) {
        const r = await fetch(`https://extensions.duckdb.org/${rel}`);
        if (!r.ok) throw new Error(`download ${rel}: HTTP ${r.status}`);
        mkdirSync(dirname(cached), { recursive: true });
        writeFileSync(cached, Buffer.from(await r.arrayBuffer()));
      }
      const out = join(options.dir!, "duckdb-extensions", rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, readFileSync(cached));
    }
    this.info(`self-hosted DuckDB ${version} parquet extension`);

    // embedding model for smart search, laid out like huggingface.co so transformers.js can use it as remoteHost
    for (const file of MODEL_FILES) {
      const cached = join(cache, "..", "models", MODEL, file);
      if (!existsSync(cached)) {
        const r = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${file}`);
        if (!r.ok) throw new Error(`download ${MODEL}/${file}: HTTP ${r.status}`);
        mkdirSync(dirname(cached), { recursive: true });
        writeFileSync(cached, Buffer.from(await r.arrayBuffer()));
      }
      const out = join(options.dir!, "models", MODEL, "resolve", "main", file);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, readFileSync(cached));
    }
    this.info(`self-hosted embedding model ${MODEL}`);

    // ONNX runtime for the model (transformers.js picks the asyncify or plain build per browser)
    const ort = fileURLToPath(new URL("node_modules/onnxruntime-web/", import.meta.url));
    for (const f of [
      "ort-wasm-simd-threaded.asyncify.mjs",
      "ort-wasm-simd-threaded.asyncify.wasm",
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.wasm",
    ]) {
      const out = join(options.dir!, "ort", f);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, readFileSync(join(ort, "dist", f)));
    }
  },
});

const EMB = JSON.parse(
  readFileSync(new URL("../src/mailbox_viewer/search-config.json", import.meta.url), "utf8"),
).embedding;
const MODEL: string = EMB.model;
// transformers.js file name per dtype
const ONNX_FILE: Record<string, string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  int8: "model_int8.onnx",
  uint8: "model_uint8.onnx",
  q4: "model_q4.onnx",
  q4f16: "model_q4f16.onnx",
  bnb4: "model_bnb4.onnx",
};
const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  `onnx/${ONNX_FILE[EMB.dtype] ?? "model_quantized.onnx"}`,
];

// onnxruntime-web has a fallback `new URL("ort-wasm-….wasm", import.meta.url)` that makes Vite copy a 27 MB file
// into every build. transformers.js always sets explicit wasm paths (jsDelivr, or /ort/ when self-hosting), so the
// fallback never runs; hide it from Vite's asset detection.
const skipOrtFallbackAsset = (): Plugin => ({
  name: "mbv-skip-ort-fallback-asset",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("onnxruntime-web") || !code.includes("import.meta.url")) return null;
    return code.replace(
      /new URL\((["'])(ort-wasm[\w.-]*\.wasm)\1,\s*import\.meta\.url\)/g,
      'new URL("$2", self.location.href)',
    );
  },
});

// build-info.json lets `mbv preview` tell a local build from one made for another host
const buildInfo = (): Plugin => ({
  name: "mbv-build-info",
  apply: "build",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "build-info.json",
      source: JSON.stringify({
        dataUrl: process.env.VITE_DATA_URL || "/data",
        base: BASE,
        selfHost: process.env.VITE_SELF_HOST === "1",
      }),
    });
  },
});

const BASE = (process.env.VITE_BASE || "/").replace(/\/?$/, "/");

export default defineConfig({
  plugins: [react(), localData(), duckdbExtensions(), skipOrtFallbackAsset(), buildInfo()],
  base: BASE,
  server: { fs: { allow: [".."] } },
  worker: { format: "es", plugins: () => [skipOrtFallbackAsset()] },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  define: { "import.meta.env.VITE_SELF_HOST_MODEL": JSON.stringify(process.env.VITE_SELF_HOST === "1" ? MODEL : "") },
});
