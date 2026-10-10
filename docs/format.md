# Dataset format

A built mailbox is a folder of static files: Parquet tables, one binary vector file, attachments and a JSON manifest. The viewer reads them with HTTP range requests; anyone else can read them with DuckDB, Polars, pandas or Arrow. This page is the contract between `mbv build` and every reader. It describes **format version 1** (`manifest.json` → `"format": 1`).

```
dist/
├── datasets.json                 list of mailboxes (home page)
└── <slug>/
    ├── manifest.json             entry point; names every other file
    ├── messages.<hash>.parquet
    ├── threads.<hash>.parquet
    ├── bodies.<hash>.parquet
    ├── attachments.<hash>.parquet
    ├── postings.<hash>.parquet
    ├── phrases.<hash>.parquet
    ├── chunks.<hash>.parquet     only with embeddings
    ├── vectors.<hash>.bin        only with embeddings
    └── att/<sha16>/<file name>   attachment files
```

## Conventions

| Topic | Rule |
|---|---|
| **File names** | `<table>.<10 hex of sha256>.<ext>`; content changes the name, so every file except `manifest.json` and `datasets.json` can be cached forever |
| **Readers** | Start from `manifest.json` → `files`; never guess hashes |
| **`doc`** | Integer message number, `0 … counts.messages-1`, newest first; joins every table |
| **`id`** | 16 hex chars, stable message id (sha1 of the Message-ID, or of date/sender/subject/body when there is none); used in URLs |
| **`thread_id`** | 16 hex chars, stable per conversation (derived from its first message) |
| **Times** | `ts` = milliseconds since the Unix epoch, UTC; `NULL` when the message has no usable date |
| **Addresses** | JSON arrays of `[name, address]` pairs; `address` is `""` for display-name-only recipients (common in PST exports) |
| **Labels** | Folder names; system folders normalised to `Inbox`, `Sent`, `Drafts`, `Spam`, `Trash`, `Archive`, `Outbox`; nested folders joined with `/` |
| **Compression** | zstd; min/max statistics only on lookup columns (keeps footers small) |

## manifest.json

| Key | Type | Meaning |
|---|---|---|
| `format` | int | Layout version (this page: `1`) |
| `generator` | string | e.g. `mailbox-viewer 0.1.0` |
| `slug`, `title`, `description` | string | URL name, display name, one-line description |
| `built_at` | string | ISO 8601 build time |
| `owner` | object or null | Detected mailbox owner `{name, addr}` |
| `counts` | object | `messages`, `threads`, `attachments`, `duplicates_merged`, `parse_errors` |
| `date_range` | [int, int] or null | First and last `ts` |
| `labels` | array | `{name, count}` per label, most used first |
| `people` | array | Top 100 correspondents `{addr, name, count}` (owner excluded) |
| `files` | object | Table name → file name (`messages`, `threads`, `bodies`, `attachments`, `postings`, `phrases`, optional `chunks`, `vectors`) |
| `search` | object | `docs`, `avg_len`, `k1`, `b` (BM25 parameters), `tokenizer` (version), `postings`, `phrases` (row counts) |
| `embedding` | object or null | `model`, `dtype`, `pooling`, `query_prefix`, `dims`, `min_score`, `count` (rows in `vectors`) |

## messages

One row per unique message. Small enough to load whole; the viewer loads a subset of columns.

| Column | Type | Notes |
|---|---|---|
| `doc` | INTEGER | Message number |
| `id` | VARCHAR | Stable message id |
| `thread_id` | VARCHAR | Conversation |
| `ts` | BIGINT | Epoch milliseconds |
| `date` | TIMESTAMP WITH TIME ZONE | Same instant as `ts`, for SQL convenience |
| `from_name`, `from_addr` | VARCHAR | Sender |
| `to_json`, `cc_json`, `bcc_json`, `reply_to_json` | VARCHAR | JSON `[[name, addr], …]` |
| `recipients` | VARCHAR | Lowercased `name <addr>; …` of to, cc and bcc, for `LIKE` searches |
| `subject` | VARCHAR | Decoded subject |
| `snippet` | VARCHAR | First ~200 characters of the new text (quoted history and links removed) |
| `labels` | VARCHAR[] | Every folder the message was found in |
| `att_json` | VARCHAR | JSON `[{n: name, t: mime, s: size, p: path, x: has text, k: index, h?: 1}]`; `h` marks inline images shown in the body |
| `att_names` | VARCHAR | Lowercased names of visible attachments joined with ` \| ` |
| `att_count` | SMALLINT | Visible attachments |
| `has_att` | BOOLEAN | `att_count > 0` |
| `size` | INTEGER | Raw message size in bytes |
| `doclen` | FLOAT | Weighted token count (BM25 length) |
| `message_id`, `in_reply_to`, `refs` | VARCHAR | Threading headers (lowercased, without angle brackets; space-separated lists) |

## threads

One row per conversation, newest first.

| Column | Type | Notes |
|---|---|---|
| `thread_id` | VARCHAR | |
| `subject` | VARCHAR | Subject of the opening message (first one without `Re:`/`Fwd:`) |
| `first_ts`, `last_ts` | BIGINT | Epoch milliseconds |
| `count` | INTEGER | Messages |
| `senders_json` | VARCHAR | Distinct senders in order of first appearance |
| `recipients_json` | VARCHAR | Up to 10 recipients (of sent messages if any), for the Sent folder |
| `snippet` | VARCHAR | Snippet of the latest message |
| `has_att`, `att_count` | BOOLEAN, INTEGER | Visible attachments across the conversation |
| `att_json` | VARCHAR | First six attachments `[{n, t, p}]` |
| `labels` | VARCHAR[] | Union of the messages' labels |
| `docs` | INTEGER[] | Message numbers, oldest first |

## bodies

Sorted by `thread_id`, then time, in row groups of about 750 KB uncompressed, so one conversation is usually one range request.

| Column | Type | Notes |
|---|---|---|
| `thread_id`, `doc`, `id` | | Lookup columns (with statistics) |
| `message_id` | VARCHAR | |
| `reply_to_json` | VARCHAR | |
| `snippet` | VARCHAR | As in `messages` |
| `text` | VARCHAR | Best plain text: the `text/plain` part, or text derived from HTML when the plain part is a stub |
| `html` | VARCHAR or NULL | Original HTML. Inline images are rewritten from `cid:…` to `mbv-att:att/<sha16>/<name>`; readers resolve that against the mailbox folder |
| `headers` | VARCHAR | Raw header block |

## attachments

Sorted by message `id`.

| Column | Type | Notes |
|---|---|---|
| `id`, `doc` | VARCHAR, INTEGER | Message |
| `idx` | SMALLINT | Position in the message (`k` in `att_json`) |
| `name`, `mime` | VARCHAR | Sanitised file name, declared type |
| `size` | BIGINT | Bytes |
| `sha256` | VARCHAR | Content hash; the file is at `path` |
| `path` | VARCHAR | `att/<sha16>/<percent-encoded name>`, relative to the mailbox folder |
| `hidden` | BOOLEAN | Inline image referenced from the HTML body |
| `text` | VARCHAR or NULL | Extracted text (PDF, DOCX, XLSX, PPTX, RTF, HTML, plain text, attached emails), at most 200,000 characters |

## postings and phrases

The word index. Rows are sorted by `term`, then `doc`, in row groups of 32,768 rows with min/max statistics on `term`, so a lookup reads only the row groups that can contain the word.

| Column | Type | Notes |
|---|---|---|
| `term` | VARCHAR | `postings`: one token. `phrases`: two adjacent tokens joined by a space |
| `doc` | INTEGER | Message |
| `tf` | FLOAT | `postings`: weighted term frequency (subject ×3, attachment names ×2, body, people and attachment text ×1). `phrases`: occurrences |

**Tokenizer (version 2):** NFKD, strip combining marks U+0300–U+036F, NFC, lowercase, then runs of letters, digits and marks; Han, Hiragana and Katakana characters become one token each; tokens longer than 40 characters are dropped. `postings` leaves out the stopwords listed in `search-config.json`; `phrases` keeps them. URLs are reduced to their host before indexing.

**Scoring:** BM25 with `k1` and `b` from the manifest, `avg_len` and `doclen` as document lengths.

## chunks and vectors

| File | Layout |
|---|---|
| `chunks` | One row per embedded chunk, in vector order: `doc` (INTEGER), `src` (SMALLINT: `-1` body, otherwise the attachment `idx`) |
| `vectors` | `count × dims` signed bytes, row-major; each row is a unit vector multiplied by 127 and rounded |

Chunks are about 180 words with 40 words of overlap: up to 12 per body (new text only, prefixed with subject and sender) and 24 per attachment. Queries must be embedded with the same `model`, `dtype` and `pooling`, prefixed with `query_prefix`; similarity is the dot product divided by 127.

## datasets.json

```json
{"datasets": [{"slug": "demo", "title": "…", "description": "…", "messages": 19, "threads": 14,
               "date_range": [1696262100000, 1714773600000], "built_at": "2026-10-09T20:48:20+00:00"}]}
```

Locally, unlisted mailboxes carry `"hidden": true`; `mbv publish` leaves them out of the published copy.

## Querying with DuckDB

```sql
-- every message from one sender, with its folder labels
SELECT to_timestamp(ts / 1000) AS sent, subject, labels
FROM 'https://<bucket>/<slug>/messages.<hash>.parquet'
WHERE from_addr = 'someone@example.org'
ORDER BY ts;

-- messages containing a word, via the index (reads a few row groups)
SELECT m.subject, p.tf
FROM 'https://<bucket>/<slug>/postings.<hash>.parquet' p
JOIN 'https://<bucket>/<slug>/messages.<hash>.parquet' m USING (doc)
WHERE p.term = 'budget'
ORDER BY p.tf DESC;
```
