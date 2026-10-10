"""dist/datasets.json: the list of mailboxes the viewer's home page shows."""

import json
from pathlib import Path

INDEX = "datasets.json"


def entry(manifest: dict, hidden: bool = False) -> dict:
    return {
        "slug": manifest["slug"],
        "title": manifest["title"],
        "description": manifest.get("description", ""),
        "messages": manifest["counts"]["messages"],
        "threads": manifest["counts"]["threads"],
        "date_range": manifest.get("date_range"),
        "built_at": manifest["built_at"],
        "hidden": hidden,
    }


def merge(index: dict | None, manifest: dict, hidden: bool = False) -> dict:
    index = index or {"datasets": []}
    rest = [d for d in index.get("datasets", []) if d["slug"] != manifest["slug"]]
    rest.append(entry(manifest, hidden))
    rest.sort(key=lambda d: d["title"].lower())
    return {"datasets": rest}


def public(index: dict) -> dict:
    """Unlisted datasets are left out of the published index (still reachable by URL)."""
    return {
        "datasets": [{k: v for k, v in d.items() if k != "hidden"} for d in index["datasets"] if not d.get("hidden")]
    }


def update_index(out: Path, manifest: dict, hidden: bool = False) -> None:
    path = out / INDEX
    index = json.loads(path.read_text()) if path.exists() else None
    path.write_text(json.dumps(merge(index, manifest, hidden), indent=1, ensure_ascii=False))
