"""Find mail sources under the given inputs and yield raw messages with their folder labels.

Accepted: .pst/.ost (converted with readpst), mbox files (any name; readpst writes 'mbox'),
Maildir folders (cur/new/tmp), .eml files and folders of raw RFC 822 files (e.g. the Enron corpus).
"""

import hashlib
import mailbox
import shutil
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .config import CACHE

GENERIC_ROOTS = {
    "personal folders",
    "top of personal folders",
    "top of outlook data file",
    "top of information store",
    "outlook data file",
    "root - mailbox",
    "ipm_subtree",
    "mailbox",
    "root",
}
SYSTEM_LABELS = {
    "inbox": "Inbox",
    "sent": "Sent",
    "sent items": "Sent",
    "sent mail": "Sent",
    "sent messages": "Sent",
    "[gmail]/sent mail": "Sent",
    "drafts": "Drafts",
    "draft": "Drafts",
    "deleted items": "Trash",
    "deleted messages": "Trash",
    "trash": "Trash",
    "bin": "Trash",
    "junk e-mail": "Spam",
    "junk email": "Spam",
    "junk": "Spam",
    "spam": "Spam",
    "bulk mail": "Spam",
    "outbox": "Outbox",
    "archive": "Archive",
}
GMAIL_META_LABELS = {"opened", "unread", "important", "archived", "starred"}


@dataclass
class Source:
    kind: str  # mbox | maildir | file
    path: Path
    label: str


def normalize_label(parts: list[str]) -> str:
    if not parts:
        return "Inbox"
    joined = "/".join(parts)
    return SYSTEM_LABELS.get(joined.lower(), joined)


def gmail_labels(raw: list[str]) -> list[str]:
    out = []
    for label in raw:
        low = label.lower()
        if low in GMAIL_META_LABELS or low.startswith("category ") or low.startswith("imap_"):
            continue
        out.append(SYSTEM_LABELS.get(low, label))
    return out


def _looks_like_mbox(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            return f.read(5) == b"From "
    except OSError:
        return False


def _looks_like_message(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            head = f.read(2048)
    except OSError:
        return False
    first = head.split(b"\n", 1)[0]
    return (
        b":" in first
        and any(h in head[:2048].lower() for h in (b"\nfrom:", b"\nsubject:", b"\nmessage-id:", b"\ndate:"))
    ) or head.lower().startswith((b"message-id:", b"return-path:", b"received:", b"from:", b"date:"))


def readpst(pst: Path) -> Path:
    """Convert a PST once into <cache>/readpst/<name>-<hash>/ (folders → directories with an 'mbox' file)."""
    if not shutil.which("readpst"):
        sys.exit(
            "readpst not found. Install libpst (macOS: brew install libpst; Debian: apt install pst-utils) or use Docker."
        )
    st = pst.stat()
    key = hashlib.sha1(f"{pst.resolve()}:{st.st_size}:{st.st_mtime_ns}".encode()).hexdigest()[:10]
    out = CACHE / "readpst" / f"{pst.stem}-{key}"
    done = out / ".done"
    if not done.exists():
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        print(f"  readpst {pst.name} → {out}", file=sys.stderr)
        subprocess.run(["readpst", "-r", "-8", "-t", "e", "-q", "-o", str(out), str(pst)], check=True)
        done.touch()
    return out


def _is_maildir(p: Path) -> bool:
    return (p / "cur").is_dir() and (p / "new").is_dir()


def _scan_dir(root: Path) -> list[tuple[str, Path, list[str]]]:
    found = []
    if _is_maildir(root):
        found.append(("maildir", root, []))
    for p in sorted(root.rglob("*")):
        rel = list(p.relative_to(root).parts)
        hidden = [part for part in rel if part.startswith(".")]
        if p.is_dir():
            if _is_maildir(p):
                if hidden and not (len(hidden) == 1 and rel[-1] == hidden[0]):
                    continue
                # Maildir++ subfolder ".Sent" / ".Archive.2020" → label "Sent" / "Archive/2020"; the root of a
                # Maildir++ tree is that account's Inbox
                if rel[-1].startswith("."):
                    label = rel[:-1] + rel[-1].lstrip(".").split(".")
                elif any(c.name.startswith(".") and _is_maildir(c) for c in p.iterdir() if c.is_dir()):
                    label = [*rel, "Inbox"]
                else:
                    label = rel
                found.append(("maildir", p, label))
            continue
        if hidden:
            continue
        if p.parent.name in ("cur", "new", "tmp") and (p.parent.parent / "cur").is_dir():
            continue  # inside a Maildir, handled above
        suffix = p.suffix.lower()
        if suffix in (".pst", ".ost"):
            for kind, sub, subrel in _scan_dir(readpst(p)):
                found.append((kind, sub, rel[:-1] + subrel))
        elif p.name == "mbox" or suffix in (".mbox", ".mbx"):
            found.append(("mbox", p, rel[:-1] if p.name == "mbox" else [*rel[:-1], p.stem]))
        elif suffix == ".eml":
            found.append(("file", p, rel[:-1]))
        elif suffix in ("", ".txt", ".msgtxt") or p.name.endswith("."):
            if _looks_like_mbox(p):
                found.append(("mbox", p, [*rel[:-1], p.stem or p.name]))
            elif _looks_like_message(p):
                found.append(("file", p, rel[:-1]))
    return found


def discover(inputs: list[Path]) -> list[Source]:
    entries: list[tuple[str, Path, list[str]]] = []
    for inp in inputs:
        inp = inp.expanduser()
        if not inp.exists():
            sys.exit(f"input not found: {inp}")
        if inp.is_dir():
            entries += _scan_dir(inp)
        elif inp.suffix.lower() in (".pst", ".ost"):
            entries += _scan_dir(readpst(inp))
        elif inp.suffix.lower() == ".eml" or (not _looks_like_mbox(inp) and _looks_like_message(inp)):
            entries.append(("file", inp, []))
        else:
            entries.append(("mbox", inp, [inp.parent.name] if inp.name == "mbox" else [inp.stem]))

    # strip a shared top folder ("Personal folders/...") and generic PST roots
    paths = [e[2] for e in entries if e[2]]
    if len({tuple(p[:1]) for p in paths}) == 1 and all(len(p) > 1 for p in paths):
        entries = [(k, p, rel[1:]) for k, p, rel in entries]
    out = []
    for kind, p, rel in entries:
        while rel and rel[0].lower() in GENERIC_ROOTS:
            rel = rel[1:]
        out.append(Source(kind, p, normalize_label(rel)))
    return out


def iter_raw(src: Source) -> Iterator[tuple[bytes, str | None]]:
    """Yield (raw message bytes, mbox 'From ' line or None)."""
    if src.kind == "file":
        yield src.path.read_bytes(), None
    elif src.kind == "maildir":
        md = mailbox.Maildir(src.path, factory=None, create=False)
        for key in md.iterkeys():
            yield md.get_bytes(key), None
    else:
        mb = mailbox.mbox(src.path, factory=None, create=False)
        try:
            for key in mb.iterkeys():
                raw = mb.get_bytes(key, from_=True)
                first, _, rest = raw.partition(b"\n")
                if first.startswith(b"From "):
                    yield rest, first.decode("latin-1")
                else:
                    yield raw, None
        finally:
            mb.close()
