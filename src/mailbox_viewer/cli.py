"""Command line interface: mailbox-viewer (alias: mbv)."""

import json
import os
import re
import shutil
import sys
from pathlib import Path

import click
from dotenv import find_dotenv, load_dotenv

from . import __version__

SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")


def _slug(ctx, param, value):
    if value is not None and not SLUG.fullmatch(value):
        raise click.BadParameter("use lowercase letters, digits and dashes (it becomes the URL path)")
    return value


def _published_slugs(dist: Path, slugs: tuple[str, ...], all_: bool) -> list[str]:
    if all_:
        return sorted(p.name for p in dist.iterdir() if (p / "manifest.json").exists()) if dist.exists() else []
    if not slugs:
        raise click.UsageError("name at least one mailbox, or pass --all")
    return list(slugs)


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.version_option(__version__, "-V", "--version", prog_name="mailbox-viewer")
@click.option(
    "--dist",
    type=click.Path(file_okay=False, path_type=Path),
    default="dist",
    show_default=True,
    envvar="MBV_DIST",
    help="Folder holding built mailboxes.",
)
@click.pass_context
def cli(ctx, dist: Path):
    """Turn mbox and PST mailboxes into a static, Gmail-style website.

    \b
    Typical use:
        mbv build inbox.pst --slug city-records-2024
        mbv preview
        mbv publish city-records-2024
    """
    load_dotenv(find_dotenv(usecwd=True))
    ctx.obj = {"dist": dist.resolve()}


@cli.command(short_help="Build a mailbox from PST, mbox, Maildir or .eml files.")
@click.argument("inputs", nargs=-1, required=True, type=click.Path(exists=True, path_type=Path))
@click.option("--slug", required=True, callback=_slug, help="URL name of the mailbox, e.g. city-records-2024.")
@click.option("--title", help="Display name. Default: the mailbox owner's name or address.")
@click.option("--description", default="", help="One line shown on the mailbox list and About dialog.")
@click.option("--no-embed", is_flag=True, help="Skip semantic vectors: word search only, no Node.js needed.")
@click.option("--unlisted", is_flag=True, help="Leave out of the public mailbox list (still reachable by URL).")
@click.pass_obj
def build(obj, inputs, slug, title, description, no_embed, unlisted):
    """Build a mailbox from .pst/.ost files, mbox files, Maildirs, .eml files or folders of them.

    Several inputs become one mailbox; messages that appear in more than one (same Message-ID) are
    merged and keep all their folders as labels.

    \b
    Examples:
        mbv build ~/Downloads/response.pst --slug county-2026-05 --title "County records, May 2026"
        mbv build "Sent Items.mbox" Inbox.mbox --slug jane-doe
    """
    from .build import build as run_build

    run_build(
        list(inputs), slug, obj["dist"], title=title, description=description, embed=not no_embed, hidden=unlisted
    )
    click.echo(f"\nNext: mbv preview  →  http://localhost:8000/{slug}", err=True)


@cli.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Interface to listen on (0.0.0.0 for all).")
@click.option("-p", "--port", default=8000, show_default=True, help="Port to listen on.")
@click.option("--no-build", is_flag=True, help="Don't rebuild the viewer from source even if it changed.")
@click.pass_obj
def preview(obj, host, port, no_build):
    """Serve the viewer and every built mailbox locally, with HTTP range requests."""
    from .serve import serve

    serve(obj["dist"], host=host, port=port, rebuild=not no_build)


@cli.command()
def setup():
    """Save Cloudflare R2 credentials to .env and check they work (interactive)."""
    from .publish import setup as run_setup

    run_setup(Path(".env").resolve())


@cli.command()
@click.argument("slugs", nargs=-1)
@click.option("--all", "all_", is_flag=True, help="Publish every mailbox in the dist folder.")
@click.option("--prune", is_flag=True, help="Delete remote files left over from older builds.")
@click.option("--dry-run", is_flag=True, help="Show what would be uploaded without uploading.")
@click.option("--no-cors", is_flag=True, help="Leave the bucket's CORS policy alone.")
@click.pass_obj
def publish(obj, slugs, all_, prune, dry_run, no_cors):
    """Upload mailboxes to Cloudflare R2 or another S3-compatible store.

    Credentials come from .env (see `mbv setup`). Only new or changed files are uploaded, and the
    manifest goes last so readers never see a half-uploaded mailbox.
    """
    from .publish import publish as run_publish

    run_publish(
        obj["dist"], _published_slugs(obj["dist"], slugs, all_), prune=prune, dry_run=dry_run, set_cors=not no_cors
    )


@cli.command()
@click.argument("slug", required=False)
def check(slug):
    """Check that the public bucket URL serves range requests with CORS headers."""
    from .publish import check as run_check

    url = os.environ.get("R2_PUBLIC_URL", "").rstrip("/")
    if not url:
        raise click.UsageError("R2_PUBLIC_URL is not set (run `mbv setup`)")
    sys.exit(0 if run_check(url, slug) else 1)


@cli.command("list")
@click.option("--json", "as_json", is_flag=True, help="Output JSON.")
@click.pass_obj
def list_(obj, as_json):
    """List the mailboxes in the dist folder."""
    idx = obj["dist"] / "datasets.json"
    datasets = json.loads(idx.read_text())["datasets"] if idx.exists() else []
    if as_json:
        click.echo(json.dumps(datasets, indent=2, ensure_ascii=False))
        return
    for d in datasets:
        flag = "  (unlisted)" if d.get("hidden") else ""
        click.echo(f"{d['slug']:30} {d['messages']:>8,} messages  {d['title']}{flag}")


@cli.command()
@click.argument("slug", callback=_slug)
@click.option("--remote", is_flag=True, help="Also delete it from the bucket.")
@click.confirmation_option(prompt="Delete this mailbox?")
@click.pass_obj
def remove(obj, slug, remote):
    """Delete a built mailbox (and with --remote, its published copy)."""
    from .datasets import INDEX

    shutil.rmtree(obj["dist"] / slug, ignore_errors=True)
    idx = obj["dist"] / INDEX
    if idx.exists():
        data = json.loads(idx.read_text())
        data["datasets"] = [d for d in data["datasets"] if d["slug"] != slug]
        idx.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    click.echo(f"removed {obj['dist'] / slug}", err=True)
    if remote:
        from .publish import unpublish

        unpublish(slug)


def main():
    cli()


if __name__ == "__main__":
    main()
