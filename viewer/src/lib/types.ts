export type Addr = [name: string, addr: string];

export interface Manifest {
  format: number;
  generator: string;
  slug: string;
  title: string;
  description: string;
  built_at: string;
  owner: { name: string; addr: string } | null;
  counts: { messages: number; threads: number; attachments: number; duplicates_merged: number; parse_errors: number };
  date_range: [number, number] | null;
  labels: { name: string; count: number }[];
  people: { addr: string; name: string; count: number }[];
  files: Record<string, string>;
  search: {
    docs: number;
    avg_len: number;
    k1: number;
    b: number;
    tokenizer: number;
    postings: number;
    phrases: number;
  };
  embedding: {
    model: string;
    dtype: string;
    pooling: string;
    query_prefix: string;
    dims: number;
    count: number;
    min_score?: number;
  } | null;
}

/** attachment metadata: name, mime type, size, URL path, has extracted text, index, hidden inline image */
export interface AttMeta {
  n: string;
  t: string;
  s?: number;
  p: string;
  x?: boolean;
  k?: number;
  h?: 1;
}

export interface Thread {
  thread_id: string;
  subject: string;
  first_ts: number | null;
  last_ts: number | null;
  count: number;
  senders: Addr[];
  recipients: Addr[];
  snippet: string;
  has_att: boolean;
  atts: AttMeta[];
  att_count: number;
  labels: string[];
  docs: number[];
}

export interface Message {
  doc: number;
  id: string;
  thread_id: string;
  ts: number | null;
  from_name: string;
  from_addr: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  labels: string[];
  atts: AttMeta[];
  att_count: number;
  size: number;
}

export interface Body {
  doc: number;
  id: string;
  message_id: string;
  reply_to: Addr[];
  snippet: string;
  text: string;
  html: string | null;
  headers: string;
}

export interface DatasetEntry {
  slug: string;
  title: string;
  description: string;
  messages: number;
  threads: number;
  date_range: [number, number] | null;
  built_at: string;
}
