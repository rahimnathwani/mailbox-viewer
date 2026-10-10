"""Upload datasets to Cloudflare R2 (or any S3-compatible store) and configure CORS for the viewer."""

import contextlib
import json
import mimetypes
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

from . import __version__
from .datasets import INDEX, merge, public
from .serve import safe_headers

IMMUTABLE = "public, max-age=31536000, immutable"
SHORT = "public, max-age=60"

CORS = {
    "CORSRules": [
        {
            "AllowedOrigins": ["*"],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedHeaders": ["Range", "Content-Type", "If-None-Match", "If-Modified-Since"],
            "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag", "Content-Type"],
            "MaxAgeSeconds": 86400,
        }
    ]
}

mimetypes.add_type("application/vnd.apache.parquet", ".parquet")

# Cloudflare rejects Python's default "Python-urllib" user agent on r2.dev
USER_AGENT = f"mailbox-viewer/{__version__} (+https://github.com/rahimnathwani/mailbox-viewer)"


def cors_help() -> str:
    """Instructions for setting CORS by hand (object-scoped R2 tokens can't change bucket settings)."""
    return "R2 dashboard → bucket → Settings → CORS Policy → Add, and paste:\n" + json.dumps(
        CORS["CORSRules"], indent=2
    )


def _env(name: str, required: bool = True) -> str:
    v = os.environ.get(name, "").strip()
    if required and not v:
        sys.exit(f"{name} is not set: copy .env.example to .env and fill it in (see README → Publish)")
    return v


def client():
    import boto3
    from botocore.config import Config

    endpoint = _env("S3_ENDPOINT_URL", required=False) or f"https://{_env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        # R2 doesn't accept every checksum header newer boto3 sends by default; Cloudflare recommends "when_required"
        config=Config(
            retries={"max_attempts": 5, "mode": "standard"},
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def _content_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _existing(s3, bucket: str, prefix: str) -> dict[str, int]:
    out = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for o in page.get("Contents", []):
            out[o["Key"]] = o["Size"]
    return out


def publish(dist: Path, slugs: list[str], prune: bool = False, dry_run: bool = False, set_cors: bool = True) -> None:
    bucket = _env("R2_BUCKET")
    public_url = _env("R2_PUBLIC_URL", required=False).rstrip("/")
    s3 = client()
    local_index = json.loads((dist / INDEX).read_text()) if (dist / INDEX).exists() else {"datasets": []}
    hidden = {d["slug"]: d.get("hidden", False) for d in local_index["datasets"]}

    if set_cors and not dry_run:
        try:
            s3.put_bucket_cors(Bucket=bucket, CORSConfiguration=CORS)
            print(f"CORS set on bucket {bucket}", file=sys.stderr)
        except Exception as e:
            print(
                f"  ! could not set the bucket's CORS policy ({e}).\n  If it isn't set yet: {cors_help()}",
                file=sys.stderr,
            )

    try:
        remote_index = json.loads(s3.get_object(Bucket=bucket, Key=INDEX)["Body"].read())
    except Exception:
        remote_index = {"datasets": []}

    for slug in slugs:
        ds = dist / slug
        manifest_path = ds / "manifest.json"
        if not manifest_path.exists():
            sys.exit(f"{ds} has no manifest.json: run `mbv build ... --slug {slug}` first")
        manifest = json.loads(manifest_path.read_text())
        prefix = f"{slug}/"
        remote = _existing(s3, bucket, prefix)
        files = [f for f in ds.rglob("*") if f.is_file()]
        uploads, wanted = [], set()
        for f in files:
            rel = f.relative_to(ds).as_posix()
            # object keys are raw names; the viewer requests them percent-encoded, which R2 decodes
            key = prefix + rel
            wanted.add(key)
            mutable = rel == "manifest.json"
            if not mutable and remote.get(key) == f.stat().st_size:
                continue  # content-addressed names: same key + size means same bytes
            uploads.append((f, key, mutable))
        stale = sorted(set(remote) - wanted)
        total = sum(f.stat().st_size for f, _, _ in uploads)
        print(
            f"{slug}: {len(uploads)} files to upload ({total / 1e6:.1f} MB), {len(files) - len(uploads)} unchanged"
            + (f", {len(stale)} stale{' (pruning)' if prune else ' (keep; --prune deletes)'}" if stale else ""),
            file=sys.stderr,
        )
        if dry_run:
            continue

        def put(item):
            f, key, mutable = item
            extra = {"ContentType": _content_type(f), "CacheControl": SHORT if mutable else IMMUTABLE}
            if key.split("/", 2)[1:2] == ["att"]:
                safe = safe_headers(f.name)
                extra["ContentType"] = safe["Content-Type"]
                kind = "attachment" if "Content-Disposition" in safe else "inline"
                extra["ContentDisposition"] = f"{kind}; filename*=UTF-8''{quote(f.name)}"
            s3.upload_file(str(f), bucket, key, ExtraArgs=extra)

        # tables and attachments first, manifest last so readers never see a manifest pointing at missing files
        body = [u for u in uploads if not u[2]]
        with ThreadPoolExecutor(8) as pool:
            for i, _ in enumerate(pool.map(put, body), 1):
                if i % 200 == 0:
                    print(f"  {i}/{len(body)}", file=sys.stderr)
        for u in uploads:
            if u[2]:
                put(u)
        if prune and stale:
            for i in range(0, len(stale), 1000):
                s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in stale[i : i + 1000]]})
        remote_index = merge(remote_index, manifest, hidden.get(slug, False))

    if dry_run:
        return
    body = json.dumps(public(remote_index), indent=1, ensure_ascii=False).encode()
    s3.put_object(Bucket=bucket, Key=INDEX, Body=body, ContentType="application/json", CacheControl=SHORT)
    print("updated datasets.json", file=sys.stderr)
    if public_url:
        for slug in slugs:
            print(f"  {public_url}/{slug}/manifest.json", file=sys.stderr)
        check(public_url, slugs[0] if slugs else None)
    else:
        print("R2_PUBLIC_URL not set: skipping the public read check", file=sys.stderr)


def check(public_url: str, slug: str | None) -> bool:
    """Read back like the browser does: CORS preflight-free GET with a Range header from another origin."""
    import urllib.request

    ok = True
    targets = [f"{public_url}/{INDEX}"]
    if slug:
        targets.append(f"{public_url}/{slug}/manifest.json")
    for url in targets:
        req = urllib.request.Request(
            url, headers={"Range": "bytes=0-99", "Origin": "https://example.com", "User-Agent": USER_AGENT}
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                h = {k.lower(): v for k, v in r.headers.items()}
                status = r.status
        except Exception as e:
            print(f"  ✗ {url}: {e}", file=sys.stderr)
            ok = False
            continue
        problems = []
        if status != 206:
            problems.append(f"status {status} (expected 206: range requests not honoured)")
        if "access-control-allow-origin" not in h:
            problems.append("no Access-Control-Allow-Origin (CORS not applied: check the bucket CORS policy)")
        elif "content-range" not in h.get("access-control-expose-headers", "").lower():
            problems.append("Content-Range not exposed via CORS")
        if problems:
            ok = False
            print(f"  ✗ {url}: " + "; ".join(problems), file=sys.stderr)
        else:
            print(f"  ✓ {url}: range + CORS ok", file=sys.stderr)
    return ok


def unpublish(slug: str) -> None:
    bucket = _env("R2_BUCKET")
    s3 = client()
    keys = list(_existing(s3, bucket, f"{slug}/"))
    for i in range(0, len(keys), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in keys[i : i + 1000]]})
    try:
        index = json.loads(s3.get_object(Bucket=bucket, Key=INDEX)["Body"].read())
    except Exception:
        index = {"datasets": []}
    index["datasets"] = [d for d in index["datasets"] if d["slug"] != slug]
    s3.put_object(
        Bucket=bucket,
        Key=INDEX,
        Body=json.dumps(index, indent=1).encode(),
        ContentType="application/json",
        CacheControl=SHORT,
    )
    print(f"deleted {len(keys)} objects under {slug}/ and removed it from datasets.json", file=sys.stderr)


def setup(env_path: Path) -> None:
    """Interactive: ask for R2 credentials, verify them, set CORS, test the public URL, write .env."""
    import getpass
    import urllib.request

    from dotenv import dotenv_values

    current = {k: v or "" for k, v in dotenv_values(env_path).items()} if env_path.exists() else {}
    print("Cloudflare R2 setup. Values are saved to .env (never committed). Enter keeps the current value.\n")
    print(
        "Dashboard → R2 Object Storage → Create bucket; then Manage API Tokens → Create Account API token\n"
        "(Object Read & Write, applied to that bucket only).\n"
    )

    def ask(key: str, label: str, secret: bool = False, default: str = "") -> str:
        cur = current.get(key) or default
        shown = ("*" * 8 if cur else "") if secret else cur
        prompt = f"{label}{f' [{shown}]' if shown else ''}: "
        v = (getpass.getpass(prompt) if secret else input(prompt)).strip()
        return v or cur

    vals = {
        "R2_ACCOUNT_ID": ask("R2_ACCOUNT_ID", "Account ID (R2 overview page, right side)"),
        "R2_ACCESS_KEY_ID": ask("R2_ACCESS_KEY_ID", "Access key ID"),
        "R2_SECRET_ACCESS_KEY": ask("R2_SECRET_ACCESS_KEY", "Secret access key", secret=True),
        "R2_BUCKET": ask("R2_BUCKET", "Bucket name", default="mailboxes"),
    }
    os.environ.update(vals)
    s3 = client()
    print("\nchecking credentials ... ", end="", flush=True)
    try:
        s3.list_objects_v2(Bucket=vals["R2_BUCKET"], MaxKeys=1)
    except Exception as e:
        sys.exit(f"failed: {e}\nCheck the account ID, keys and bucket name, and that the token can access this bucket.")
    print("ok")
    print("setting CORS ... ", end="", flush=True)
    try:
        s3.put_bucket_cors(Bucket=vals["R2_BUCKET"], CORSConfiguration=CORS)
        print("ok")
    except Exception as e:
        print(f"not allowed with this token ({type(e).__name__}); set it once by hand:\n{cors_help()}")

    print("\nPublic access: bucket → Settings → Public Development URL → Enable, or connect a custom domain.")
    vals["R2_PUBLIC_URL"] = ask("R2_PUBLIC_URL", "Public bucket URL (https://pub-….r2.dev or your domain)").rstrip("/")
    _write_env(env_path, vals)
    print(f"saved {env_path}")
    if vals["R2_PUBLIC_URL"]:
        key = ".mbv-check.txt"
        s3.put_object(Bucket=vals["R2_BUCKET"], Key=key, Body=b"mailbox viewer check\n", ContentType="text/plain")
        url = f"{vals['R2_PUBLIC_URL']}/{key}"
        req = urllib.request.Request(
            url, headers={"Range": "bytes=0-6", "Origin": "https://example.com", "User-Agent": USER_AGENT}
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                h = {k.lower(): v for k, v in r.headers.items()}
                ok = r.status == 206 and "access-control-allow-origin" in h
                print(
                    f"public read ... {'ok' if ok else 'reachable, but range/CORS headers missing: ' + str(r.status)}"
                )
        except Exception as e:
            print(f"public read ... failed ({e}). Is public access enabled, and is the URL right?")
        finally:
            with contextlib.suppress(Exception):
                s3.delete_object(Bucket=vals["R2_BUCKET"], Key=key)
    print(
        "\nnext: uv run mbv publish <slug>   and set VITE_DATA_URL on Vercel to",
        vals["R2_PUBLIC_URL"] or "your public URL",
    )


def _write_env(env_path: Path, vals: dict[str, str]) -> None:
    """Update or add keys in .env, keeping other lines; the file is created owner-readable only."""
    lines = env_path.read_text().splitlines() if env_path.exists() else []
    done = set()
    for i, line in enumerate(lines):
        k = line.split("=", 1)[0].strip()
        if k in vals:
            lines[i] = f"{k}={vals[k]}"
            done.add(k)
    lines += [f"{k}={v}" for k, v in vals.items() if k not in done]
    fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    env_path.chmod(0o600)
