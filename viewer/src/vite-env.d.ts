/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DATA_URL?: string;
  /** "1": serve DuckDB-WASM, its parquet extension and the embedding model from this site (no third-party requests) */
  readonly VITE_SELF_HOST?: string;
  /** set by the build in self-host mode: the embedding model copied into /models/ */
  readonly VITE_SELF_HOST_MODEL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
