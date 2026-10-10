# CLI reference

`mbv` and `mailbox-viewer` are the same command. This page is generated from `--help`; run `make docs` after changing the CLI.

<!-- [[[cog
import cog
from click.testing import CliRunner
from mailbox_viewer.cli import cli

for name in [None, "build", "preview", "setup", "publish", "check", "list", "remove"]:
    args = ([name] if name else []) + ["--help"]
    result = CliRunner().invoke(cli, args, prog_name="mbv", terminal_width=100)
    cog.out(f"## mbv {name or ''}\n\n```\n{result.output}```\n\n".replace("## mbv \n", "## mbv\n"))
]]] -->
## mbv

```
Usage: mbv [OPTIONS] COMMAND [ARGS]...

  Turn mbox and PST mailboxes into a static, Gmail-style website.

  Typical use:
      mbv build inbox.pst --slug city-records-2024
      mbv preview
      mbv publish city-records-2024

Options:
  -V, --version     Show the version and exit.
  --dist DIRECTORY  Folder holding built mailboxes.  [default: dist]
  -h, --help        Show this message and exit.

Commands:
  build    Build a mailbox from PST, mbox, Maildir or .eml files.
  check    Check that the public bucket URL serves range requests with CORS headers.
  list     List the mailboxes in the dist folder.
  preview  Serve the viewer and every built mailbox locally, with HTTP range requests.
  publish  Upload mailboxes to Cloudflare R2 or another S3-compatible store.
  remove   Delete a built mailbox (and with --remote, its published copy).
  setup    Save Cloudflare R2 credentials to .env and check they work (interactive).
```

## mbv build

```
Usage: mbv build [OPTIONS] INPUTS...

  Build a mailbox from .pst/.ost files, mbox files, Maildirs, .eml files or folders of them.

  Several inputs become one mailbox; messages that appear in more than one (same Message-ID) are
  merged and keep all their folders as labels.

  Examples:
      mbv build ~/Downloads/response.pst --slug county-2026-05 --title "County records, May 2026"
      mbv build "Sent Items.mbox" Inbox.mbox --slug jane-doe

Options:
  --slug TEXT         URL name of the mailbox, e.g. city-records-2024.  [required]
  --title TEXT        Display name. Default: the mailbox owner's name or address.
  --description TEXT  One line shown on the mailbox list and About dialog.
  --no-embed          Skip semantic vectors: word search only, no Node.js needed.
  --unlisted          Leave out of the public mailbox list (still reachable by URL).
  -h, --help          Show this message and exit.
```

## mbv preview

```
Usage: mbv preview [OPTIONS]

  Serve the viewer and every built mailbox locally, with HTTP range requests.

Options:
  --host TEXT         Interface to listen on (0.0.0.0 for all).  [default: 127.0.0.1]
  -p, --port INTEGER  Port to listen on.  [default: 8000]
  --no-build          Don't rebuild the viewer from source even if it changed.
  -h, --help          Show this message and exit.
```

## mbv setup

```
Usage: mbv setup [OPTIONS]

  Save Cloudflare R2 credentials to .env and check they work (interactive).

Options:
  -h, --help  Show this message and exit.
```

## mbv publish

```
Usage: mbv publish [OPTIONS] [SLUGS]...

  Upload mailboxes to Cloudflare R2 or another S3-compatible store.

  Credentials come from .env (see `mbv setup`). Only new or changed files are uploaded, and the
  manifest goes last so readers never see a half-uploaded mailbox.

Options:
  --all       Publish every mailbox in the dist folder.
  --prune     Delete remote files left over from older builds.
  --dry-run   Show what would be uploaded without uploading.
  --no-cors   Leave the bucket's CORS policy alone.
  -h, --help  Show this message and exit.
```

## mbv check

```
Usage: mbv check [OPTIONS] [SLUGS]...

  Check that the public bucket URL serves range requests with CORS headers.

Options:
  -h, --help  Show this message and exit.
```

## mbv list

```
Usage: mbv list [OPTIONS]

  List the mailboxes in the dist folder.

Options:
  --json      Output JSON.
  -h, --help  Show this message and exit.
```

## mbv remove

```
Usage: mbv remove [OPTIONS] SLUG

  Delete a built mailbox (and with --remote, its published copy).

Options:
  --remote    Also delete it from the bucket.
  --yes       Confirm the action without prompting.
  -h, --help  Show this message and exit.
```

<!-- [[[end]]] -->
