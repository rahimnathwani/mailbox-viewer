# Getting started

## Install

| Need | Install (macOS) | Used for |
|---|---|---|
| **uv** | `brew install uv` | Runs the Python tool and its dependencies |
| **Node.js 20+** | `brew install node` | Embeddings for smart search; building the viewer from source |
| **readpst** | `brew install libpst` (Debian/Ubuntu: `apt install pst-utils`) | `.pst`/`.ost` input only |

Then either install the command (from a release, or straight from git, which builds the viewer with Node.js once):

```zsh
uv tool install git+https://github.com/rahimnathwani/mailbox-viewer   # installs `mbv` and `mailbox-viewer`
```

or work from a clone, which is what you want if you will deploy the viewer yourself:

```zsh
git clone https://github.com/rahimnathwani/mailbox-viewer
cd mailbox-viewer
uv run mbv --help
```

**Docker** has everything (uv, Node.js, readpst) in one image; see [Docker](#docker) below.

## Build a mailbox

```zsh
mbv build ~/Downloads/response.pst --slug county-2026-05 --title "County records, May 2026"
```

| Option | Meaning |
|---|---|
| `INPUTS…` | `.pst`/`.ost`, mbox files (any name), Maildir folders, `.eml` files, or folders containing any of these |
| `--slug` | URL name: lowercase letters, digits, dashes |
| `--title` | Display name; defaults to the mailbox owner's name, made unique if another mailbox already uses it |
| `--description` | One line for the mailbox list and About dialog |
| `--no-embed` | Skip smart search vectors (no Node.js needed) |
| `--unlisted` | Keep it off the public list; still reachable by URL |

The result goes to `./dist/<slug>/` (change with `--dist`). Rebuilding is fast: PST conversions, attachment text and embeddings are cached in `~/.cache/mailbox-viewer` (`MBV_CACHE` to move it).

### What happens to your mail

| Input | Labels | Notes |
|---|---|---|
| **PST/OST** | One per Outlook folder; Inbox, Sent Items, Deleted Items, Junk E-mail map to Inbox, Sent, Trash, Spam | Converted once with `readpst` |
| **mbox** | Folder path plus file name (`Sent Items.mbox` → Sent); readpst's `…/Inbox/mbox` → Inbox | Gmail Takeout's `X-Gmail-Labels` are used when present |
| **Maildir / Maildir++** | Root → Inbox, `.Sent` → Sent, `.Archive.2020` → Archive/2020 | |
| **eml / raw message files** | Folder path | Works for the Enron corpus layout |
| **Several inputs** | Union | Duplicates (same Message-ID) are merged and keep every label |

Conversations are rebuilt from `References`/`In-Reply-To`, Outlook's `Thread-Index`, and, when a PST export lost those headers, from reply subjects shared by the same people within 120 days. Identical newsletter subjects without `Re:` stay separate.

Text is extracted from PDF, DOCX, XLSX, PPTX, RTF, HTML, plain-text and attached-email files so their contents are searchable.

## Preview

```zsh
mbv preview            # http://localhost:8000
```

The home page lists every mailbox in `dist/`; each lives at `/<slug>`. In a source checkout the viewer is rebuilt automatically when its sources change.

## Try the demo mailbox

The repository includes a small fictional mailbox (threads, attachments, labels, spam, HTML mail, accents, CJK):

```zsh
uv run mbv build tests/fixtures/demo --slug demo
uv run mbv preview
```

## Docker

```zsh
docker compose run --rm mbv build input/response.pst --slug county-2026-05
docker compose up                                   # http://localhost:8000
docker compose run --rm mbv publish county-2026-05  # reads .env
```

`input/` and `dist/` are mounted from the current folder; caches live in a named volume.

Next: [publish it](publishing.md).
