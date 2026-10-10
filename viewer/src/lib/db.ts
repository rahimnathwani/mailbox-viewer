// DuckDB-WASM, loaded from jsDelivr so the deploy stays small. Remote parquet files are read with
// HTTP range requests: only footers and the row groups a query needs are downloaded.
import * as duckdb from "@duckdb/duckdb-wasm";
import { siteUrl } from "./site";

let dbPromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;

export function connect(): Promise<duckdb.AsyncDuckDBConnection> {
  dbPromise ??= (async () => {
    let worker: Worker;
    let bundle: duckdb.DuckDBBundle;
    if (import.meta.env.VITE_SELF_HOST === "1") {
      // served from this site: no third-party request, works where the CDN is blocked (adds ~75 MB to the deploy)
      const [mvpWasm, mvpWorker, ehWasm, ehWorker] = await Promise.all([
        import("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"),
        import("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"),
        import("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"),
        import("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"),
      ]);
      bundle = await duckdb.selectBundle({
        mvp: { mainModule: mvpWasm.default, mainWorker: mvpWorker.default },
        eh: { mainModule: ehWasm.default, mainWorker: ehWorker.default },
      });
      worker = new Worker(bundle.mainWorker!);
    } else {
      bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker!}");`], { type: "text/javascript" }),
      );
      worker = new Worker(workerUrl);
      setTimeout(() => URL.revokeObjectURL(workerUrl), 10_000);
    }
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker).catch((e) => {
      throw new Error(
        `Could not start the database engine (${e?.message || e}). ` +
          (import.meta.env.VITE_SELF_HOST === "1"
            ? ""
            : "It loads from cdn.jsdelivr.net; is that blocked on this network?"),
      );
    });
    await db.open({
      query: { castBigIntToDouble: true, castTimestampToDate: false },
      // R2, S3 and `mbv preview` answer HEAD + Range with 206, so trust it and read byte ranges
      filesystem: { reliableHeadRequests: true, allowFullHTTPReads: true, forceFullHTTPReads: false },
    });
    const conn = await db.connect();
    if (import.meta.env.VITE_SELF_HOST === "1") {
      await conn.query(`SET custom_extension_repository = '${siteUrl("duckdb-extensions")}'`);
    }
    for (const s of ["SET enable_http_metadata_cache = true", "SET enable_object_cache = true"]) {
      try {
        await conn.query(s);
      } catch {
        /* older builds */
      }
    }
    return conn;
  })().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

type Row = Record<string, unknown>;

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "toArray" in v && typeof (v as { toArray: unknown }).toArray === "function") {
    return Array.from((v as { toArray(): ArrayLike<unknown> }).toArray(), plain);
  }
  return v;
}

function rows<T>(table: { toArray(): unknown[]; schema: { fields: { name: string }[] } }): T[] {
  const names = table.schema.fields.map((f) => f.name);
  return table.toArray().map((r) => {
    const o: Row = {};
    const rec = r as Row;
    for (const n of names) o[n] = plain(rec[n]);
    return o as T;
  });
}

export async function query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await connect();
  if (!params.length) return rows<T>(await conn.query(sql));
  const stmt = await conn.prepare(sql);
  try {
    return rows<T>(await stmt.query(...params));
  } finally {
    await stmt.close();
  }
}

export async function exec(sql: string): Promise<void> {
  const conn = await connect();
  await conn.query(sql);
}

export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
