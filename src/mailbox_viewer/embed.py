"""Document embeddings via embed/embed.mjs (run with Node.js): the same transformers.js model and settings the browser
uses for queries, so both sides produce comparable vectors."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from .config import CACHE, EMBED_SOURCE, SEARCH_CONFIG_PATH


def require_node() -> None:
    if not shutil.which("node") or not shutil.which("npm"):
        sys.exit("Node.js 20+ is needed for embeddings (brew install node), or build with --no-embed")


def npm_ci(folder: Path) -> None:
    print(f"  installing node packages in {folder} ...", file=sys.stderr)
    cmd = ["npm", "ci" if (folder / "package-lock.json").exists() else "install", "--no-audit", "--no-fund"]
    subprocess.run(cmd, cwd=folder, check=True)


def embed_dir() -> Path:
    """The embedding script with its node_modules, kept in the cache so installed copies work too.
    One folder per lockfile, so upgrades get fresh dependencies."""
    require_node()
    lock = (EMBED_SOURCE / "package.json").read_bytes() + (EMBED_SOURCE / "package-lock.json").read_bytes()
    folder = CACHE / f"embed-{hashlib.sha1(lock).hexdigest()[:10]}"
    if not (folder / "node_modules").exists():
        folder.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(EMBED_SOURCE / name, folder / name)
        npm_ci(folder)
    shutil.copy2(EMBED_SOURCE / "embed.mjs", folder / "embed.mjs")
    return folder


def embed_chunks(texts: list[str], out: Path, work: Path) -> None:
    folder = embed_dir()
    src = work / "chunks.jsonl"
    with src.open("w") as f:
        for t in texts:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    subprocess.run(
        [
            "node",
            str(folder / "embed.mjs"),
            "--in",
            str(src),
            "--out",
            str(out),
            "--config",
            str(SEARCH_CONFIG_PATH),
            "--cache",
            str(CACHE / "embeddings"),
        ],
        check=True,
    )
