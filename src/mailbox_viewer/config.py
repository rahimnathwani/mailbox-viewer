"""Paths and the search/embedding settings shared with the viewer.

Works both from a source checkout (viewer sources next to the package, rebuilt on demand) and
from an installed wheel (prebuilt viewer bundled inside the package).
"""

import json
import os
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
SEARCH_CONFIG_PATH = PACKAGE / "search-config.json"
SHARED = json.loads(SEARCH_CONFIG_PATH.read_text())

#: Node script and lockfile for build-time embeddings (installed into the cache on first use)
EMBED_SOURCE = PACKAGE / "embed"

#: Viewer sources, only present in a git checkout
_repo = PACKAGE.parents[1]
VIEWER_SOURCE: Path | None = _repo / "viewer" if (_repo / "viewer" / "package.json").exists() else None

#: Prebuilt viewer shipped inside wheels
VIEWER_BUNDLED = PACKAGE / "viewer"


def cache_dir() -> Path:
    """PST conversions, embedding and attachment-text caches, scratch space for builds."""
    if env := os.environ.get("MBV_CACHE"):
        return Path(env).expanduser()
    base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    return Path(base) / "mailbox-viewer"


CACHE = cache_dir()

#: Version of the dataset layout written by `build` (manifest.json "format")
FORMAT_VERSION = 1
