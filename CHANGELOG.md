# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org). The [dataset format](docs/format.md) has its own version number.

## [Unreleased]

### Changed

- The live demo runs the documented setup: viewer on Vercel, data on Cloudflare R2 (it was on GitHub Pages). `make publish-demo` updates its data.
- The publishing guide follows the current Cloudflare dashboard, including setting CORS by hand when the API token is limited to one bucket.

### Fixed

- `mbv check` and `mbv setup` reported public `r2.dev` URLs as broken: Cloudflare rejects Python's default user agent.
- When the token can't set CORS, `mbv publish` and `mbv setup` print the policy to paste instead of a bare error.

## [0.1.0] - 2026-10-09

First release.

### Build (`mbv`)

- Reads `.pst`/`.ost` (via readpst), mbox, Maildir/Maildir++, `.eml` and folders of raw messages; several inputs become one mailbox, deduplicated on Message-ID, with folders kept as labels.
- Rebuilds conversations from References/In-Reply-To, Outlook's Thread-Index, and reply subjects shared by the same people.
- Handles PST quirks: display-name-only recipients, "Last, First" names, raw 8-bit headers, missing reply headers.
- Extracts searchable text from PDF, DOCX, XLSX, PPTX, RTF, HTML and attached emails.
- Writes the [dataset format](docs/format.md) version 1: Parquet tables, a term-sorted word and phrase index, int8 embedding vectors, content-hashed file names.
- `mbv publish` uploads to Cloudflare R2 or any S3-compatible store, sets CORS and checks public range reads; `mbv setup` saves and tests credentials.
- `mbv preview` serves everything locally with HTTP range requests.

### Viewer

- Gmail-style inbox, labels, conversations, attachment previews, stars, read state, keyboard shortcuts, dark mode and mobile layout.
- Search with Gmail's operators, phrases, exclusions and OR groups; filter chips and advanced search; conversation suggestions while typing.
- Smart search with an embedding model running in the browser.
- CSV export of any list or search.
- Reads only the byte ranges it needs through DuckDB-WASM; optional fully self-hosted build (`VITE_SELF_HOST=1`).

[Unreleased]: https://github.com/rahimnathwani/mailbox-viewer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rahimnathwani/mailbox-viewer/releases/tag/v0.1.0
