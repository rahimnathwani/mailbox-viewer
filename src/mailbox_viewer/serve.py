"""Local preview: the built viewer at / and dist/ at /data/, with HTTP Range support (DuckDB-WASM needs it)."""

import contextlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .config import SEARCH_CONFIG_PATH, VIEWER_BUNDLED, VIEWER_SOURCE
from .embed import npm_ci

mimetypes.add_type("application/vnd.apache.parquet", ".parquet")
mimetypes.add_type("application/octet-stream", ".bin")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

# Attachments are untrusted. Only types a browser displays without running code are served inline;
# text-like types (html, xml, scripts, markdown, ...) become plain text and everything else downloads.
INLINE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/avif",
    "image/tiff",
    "application/pdf",
    "text/plain",
    "text/csv",
}


def safe_headers(name: str) -> dict[str, str]:
    ctype, encoding = mimetypes.guess_type(name)
    if ctype is None or encoding:  # unknown, or .gz/.br variants that would be served under the inner type
        return {"Content-Type": "application/octet-stream", "Content-Disposition": "attachment"}
    if ctype in INLINE_TYPES or ctype.startswith(("audio/", "video/")):
        return {"Content-Type": ctype}
    if ctype == "image/svg+xml":  # <img> still renders it; opened directly it downloads instead of running scripts
        return {"Content-Type": ctype, "Content-Disposition": "attachment"}
    if ctype.startswith("text/") or ctype.endswith(("xml", "javascript", "json", "ecmascript")):
        return {"Content-Type": "text/plain; charset=utf-8"}
    return {"Content-Type": ctype, "Content-Disposition": "attachment"}  # office files, svg, archives, ...


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: DuckDB issues many small range requests

    def __init__(self, *a, viewer: Path, data: Path, **kw):
        self.viewer, self.data = viewer, data
        super().__init__(*a, directory=str(viewer), **kw)

    def log_message(self, fmt, *args):
        if os.environ.get("MBV_VERBOSE"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, ETag")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.end_headers()

    def _resolve(self) -> Path | None:
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/data/"):
            base, rel = self.data, path[len("/data/") :]
        else:
            base, rel = self.viewer, path.lstrip("/")
        target = (base / rel).resolve()
        if base.resolve() not in target.parents and target != base.resolve():
            return None
        if target.is_dir():
            target = target / "index.html"
        # single-page app: /<slug> and other client routes load index.html
        if not target.exists() and base is self.viewer and not re.search(r"\.[a-z0-9]{1,6}$", rel):
            target = self.viewer / "index.html"
        return target if target.is_file() else None

    def do_HEAD(self):
        self._serve(head=True)

    def do_GET(self):
        self._serve(head=False)

    def _serve(self, head: bool):
        target = self._resolve()
        if target is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        size = target.stat().st_size
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        extra = safe_headers(target.name) if "/att/" in self.path else {}
        ctype = extra.pop("Content-Type", ctype)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = HTTPStatus.OK
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in extra.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        with target.open("rb") as f:
            f.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = f.read(min(1 << 16, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def _viewer_stale(src: Path) -> bool:
    """True when viewer/dist is missing, older than its sources, or was built for another host."""
    built = src / "dist" / "index.html"
    if not built.exists():
        return True
    try:
        info = json.loads((src / "dist" / "build-info.json").read_text())
    except (OSError, ValueError):
        return True
    if info.get("dataUrl") != "/data" or info.get("base") != "/":
        return True  # e.g. built for Vercel with VITE_DATA_URL; preview needs /data
    t = built.stat().st_mtime
    watched = [src / "src", src / "index.html", src / "package.json", src / "vite.config.ts", SEARCH_CONFIG_PATH]
    for w in watched:
        files = [w] if w.is_file() else w.rglob("*")
        if any(f.is_file() and f.stat().st_mtime > t for f in files):
            return True
    return False


def build_viewer(src: Path, force: bool = False) -> None:
    if not force and not _viewer_stale(src):
        return
    if not shutil.which("npm"):
        sys.exit("npm not found: install Node.js 20+ to build the viewer from source (or use Docker)")
    if not (src / "node_modules").exists():
        npm_ci(src)
    print("building viewer ...", file=sys.stderr)
    env = {k: v for k, v in os.environ.items() if k not in ("VITE_DATA_URL", "VITE_BASE", "VITE_SELF_HOST")}
    subprocess.run(["npm", "run", "build"], cwd=src, check=True, env=env)


def viewer_root(rebuild: bool = True) -> Path:
    """The viewer to serve: built from source in a checkout, otherwise the copy bundled in the package."""
    if VIEWER_SOURCE is not None:
        if rebuild:
            build_viewer(VIEWER_SOURCE)
        if (VIEWER_SOURCE / "dist" / "index.html").exists():
            return VIEWER_SOURCE / "dist"
    if (VIEWER_BUNDLED / "index.html").exists():
        return VIEWER_BUNDLED
    sys.exit("no built viewer found: run from a source checkout with Node.js installed, or install a release")


def serve(data: Path, host: str = "127.0.0.1", port: int = 8000, rebuild: bool = True) -> None:
    viewer = viewer_root(rebuild)
    data.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((host, port), partial(Handler, viewer=viewer, data=data))
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print(f"Serving http://{shown}:{port}/  (data: {data}, viewer: {viewer})", file=sys.stderr)
    with contextlib.suppress(KeyboardInterrupt):
        httpd.serve_forever()
