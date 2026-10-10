"""Build a dataset: inputs → dist/<slug>/ (parquet tables, search index, vectors, attachments, manifest)."""

import hashlib
import itertools
import json
import re
import shutil
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, unquote

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from . import __version__
from .attachments import EXTRACTABLE_EXT, EXTRACTOR_VERSION, extract_text
from .config import CACHE, FORMAT_VERSION, SHARED
from .datasets import update_index
from .embed import embed_chunks
from .ingest import discover, gmail_labels, iter_raw
from .parse import Parsed, parse_message
from .textutil import STOPWORDS, chunk_words, clean_body, has_reply_prefix, snippet, tokenize, urls_to_hosts
from .threads import assign_threads

BM25 = SHARED["bm25"]
W = BM25["weights"]
EMB = SHARED["embedding"]
MAX_INDEX_ATT_CHARS = 100_000


def log(*a):
    print(*a, file=sys.stderr, flush=True)


@dataclass
class Rec:
    key: str
    p: Parsed
    labels: list[str]
    atts: list[dict]
    participants: frozenset = field(default_factory=frozenset)
    # filled after threading
    doc: int = -1
    id: str = ""
    thread_id: str = ""

    # threading interface
    @property
    def message_id(self):
        return self.p.message_id

    @property
    def in_reply_to(self):
        return self.p.in_reply_to

    @property
    def references(self):
        return self.p.references

    @property
    def thread_index(self):
        return self.p.thread_index

    @property
    def subject(self):
        return self.p.subject

    @property
    def date(self):
        return self.p.date

    @property
    def ts(self):
        return int(self.p.date.timestamp() * 1000) if self.p.date else None


def _unique_title(out: Path, slug: str, title: str) -> str:
    """Two mailboxes of the same person would both be titled after them; add the slug to tell them apart."""
    index = out / "datasets.json"
    taken = (
        {d["title"] for d in json.loads(index.read_text())["datasets"] if d["slug"] != slug}
        if index.exists()
        else set()
    )
    return f"{title} ({slug})" if title in taken else title


def _thread_subject(members: list) -> str:
    """Subject of the opening message: the earliest one without "Re:"/"Fwd:", since clocks and
    time zones can date a reply before the message it answers."""
    for r in members:
        if r.p.subject and not has_reply_prefix(r.p.subject):
            return r.p.subject
    return next((r.p.subject for r in members if r.p.subject), "")


def _norm_name(n: str) -> str:
    """'Whitfield, Dana' → 'Dana Whitfield' (Outlook's Last, First display names)."""
    m = re.fullmatch(r"\s*([^,\s]+)\s*,\s*([^,]+?)\s*", n or "")
    return f"{m.group(2)} {m.group(1)}" if m else (n or "").strip()


def _h(s: str, n: int = 16) -> str:
    return hashlib.sha1(s.encode("utf-8", "replace")).hexdigest()[:n]


def _dedupe_key(p: Parsed) -> str:
    if p.message_id:
        return "id:" + p.message_id
    basis = f"{p.date}|{p.from_[1]}|{p.subject}|{p.text[:4000]}"
    return "h:" + hashlib.sha1(basis.encode("utf-8", "replace")).hexdigest()


def _rewrite_cids(html: str, cid_paths: dict[str, str]) -> tuple[str, set[str]]:
    used = set()

    def sub(m):
        cid = unquote(m.group(1)).strip("<>").lower()
        path = cid_paths.get(cid)
        if not path:
            return m.group(0)
        used.add(cid)
        return "mbv-att:" + path

    return re.sub(r"cid:([^\"'\s>)]+)", sub, html, flags=re.I), used


class Builder:
    def __init__(self, inputs, slug, out, title=None, description="", embed=True, hidden=False):
        self.inputs, self.slug, self.title, self.description = inputs, slug, title, description
        self.do_embed, self.hidden = embed, hidden
        self.out = out
        self.ds = out / slug
        self.work = CACHE / "work" / slug
        self.recs: dict[str, Rec] = {}
        self.stats = Counter()

    # ---------- 1. parse ----------
    def parse(self):
        if self.work.exists():
            shutil.rmtree(self.work)
        self.work.mkdir(parents=True)
        self.ds.mkdir(parents=True, exist_ok=True)
        for old in self.ds.glob("*.parquet"):
            old.unlink()
        for old in self.ds.glob("*.bin"):
            old.unlink()
        self.db = sqlite3.connect(self.work / "spool.sqlite", timeout=60)
        self.db.execute("CREATE TABLE body (key TEXT PRIMARY KEY, text TEXT, html TEXT, headers TEXT)")
        # extracted attachment text survives rebuilds (keyed by content hash and extractor version)
        # own autocommit connection in WAL mode: concurrent builds share it without holding locks
        CACHE.mkdir(parents=True, exist_ok=True)
        self.cache_db = sqlite3.connect(CACHE / "attachment-text.sqlite", timeout=60, isolation_level=None)
        self.cache_db.execute("PRAGMA journal_mode=WAL")
        self.cache_db.execute("CREATE TABLE IF NOT EXISTS atext_cache (key TEXT PRIMARY KEY, text TEXT)")
        self.db.execute("CREATE TABLE atext (sha TEXT PRIMARY KEY, text TEXT)")
        self.att_paths: set[str] = set()

        sources = discover(self.inputs)
        if not sources:
            sys.exit("no mail found in the inputs")
        t0 = time.time()
        for src in sources:
            n0 = self.stats["seen"]
            for raw, from_line in iter_raw(src):
                self.stats["seen"] += 1
                try:
                    p = parse_message(raw, from_line)
                except Exception as e:  # keep going; report at the end
                    self.stats["parse_errors"] += 1
                    log(f"  ! parse error in {src.path.name}: {type(e).__name__}: {e}")
                    continue
                self._add(p, gmail_labels(p.gmail_labels) or [src.label])
                if self.stats["seen"] % 1000 == 0:
                    log(f"  parsed {self.stats['seen']:,} ({self.stats['seen'] / (time.time() - t0):.0f}/s)")
            log(f"  {src.label}: {self.stats['seen'] - n0:,} messages  ({src.path})")
        self.db.commit()
        log(
            f"parsed {self.stats['seen']:,} messages, {len(self.recs):,} unique, "
            f"{self.stats['duplicates']:,} duplicates merged, {self.stats['parse_errors']} errors"
        )

    def _add(self, p: Parsed, labels: list[str]):
        key = _dedupe_key(p)
        if key in self.recs:
            rec = self.recs[key]
            rec.labels = sorted(set(rec.labels) | set(labels))
            self.stats["duplicates"] += 1
            return
        atts, cid_paths = [], {}
        for k, a in enumerate(p.attachments):
            sha = a.sha256
            path = f"att/{sha[:16]}/{quote(a.name, safe='')}"
            fpath = self.ds / "att" / sha[:16] / a.name
            if not fpath.exists():
                fpath.parent.mkdir(parents=True, exist_ok=True)
                fpath.write_bytes(a.data)
            self.att_paths.add(str(fpath.relative_to(self.ds)))
            ext = a.name.lower().rsplit(".", 1)[-1] if "." in a.name else ""
            has_text = False
            if ext in EXTRACTABLE_EXT or a.mime.startswith("text/") or a.mime in ("application/pdf", "message/rfc822"):
                row = self.db.execute("SELECT length(text) FROM atext WHERE sha=?", (sha,)).fetchone()
                if row is None:
                    cache_key = f"{sha}:{EXTRACTOR_VERSION}"
                    cached = self.cache_db.execute("SELECT text FROM atext_cache WHERE key=?", (cache_key,)).fetchone()
                    text = cached[0] if cached else extract_text(a.name, a.mime, a.data)
                    if not cached:
                        self.cache_db.execute("INSERT OR REPLACE INTO atext_cache VALUES (?,?)", (cache_key, text))
                    self.db.execute("INSERT INTO atext VALUES (?,?)", (sha, text))
                    has_text = bool(text)
                else:
                    has_text = bool(row[0])
            if a.cid:
                cid_paths[a.cid.lower()] = path
            atts.append(
                {
                    "n": a.name,
                    "t": a.mime,
                    "s": len(a.data),
                    "p": path,
                    "sha": sha,
                    "inline": a.inline,
                    "cid": a.cid,
                    "x": has_text,
                    "k": k,
                }
            )
        html = p.html
        if html and cid_paths:
            html, used = _rewrite_cids(html, cid_paths)
            for a in atts:
                if a["cid"] and a["cid"].lower() in used:
                    a["hidden"] = True
        self.db.execute("INSERT INTO body VALUES (?,?,?,?)", (key, p.text, html, p.headers))
        p.html = None  # keep memory flat; bodies live in the spool
        people = {a for _, a in [p.from_, *p.to, *p.cc, *p.bcc] if a}
        rec = Rec(key, p, sorted(set(labels)), atts, frozenset(people))
        p.attachments = []
        self.recs[key] = rec

    # ---------- 2. threads, ids, order ----------
    def organize(self):
        recs = list(self.recs.values())
        groups = assign_threads(recs)
        by_group = defaultdict(list)
        for r, g in zip(recs, groups):
            by_group[g].append(r)
        for members in by_group.values():
            members.sort(key=lambda r: (r.ts is None, r.ts or 0))
            tid = _h("t:" + members[0].key)
            for r in members:
                r.thread_id = tid
        recs.sort(key=lambda r: (r.ts is None, -(r.ts or 0)))
        for i, r in enumerate(recs):
            r.doc = i
            r.id = _h(r.key)
        self.ordered = recs
        self.threads = sorted(by_group.values(), key=lambda m: -(max((r.ts or 0) for r in m)))
        log(f"{len(recs):,} messages in {len(self.threads):,} threads")
        self.db.execute("CREATE TABLE ord (key TEXT PRIMARY KEY, doc INT, id TEXT, thread_id TEXT, ts INT)")
        self.db.executemany(
            "INSERT INTO ord VALUES (?,?,?,?,?)", [(r.key, r.doc, r.id, r.thread_id, r.ts) for r in recs]
        )
        self.db.commit()

    def detect_owner(self):
        """The address taking part in the most messages (from/to/cc), counting display-name-only
        mentions that match it ("Dana Whitfield", or just "Dana" once the full name is known)."""
        part, name_only = Counter(), Counter()
        names = defaultdict(Counter)
        for r in self.ordered:
            seen = set()
            for n, a in [r.p.from_, *r.p.to, *r.p.cc]:
                if a:
                    if a not in seen:
                        part[a] += 1
                        seen.add(a)
                    if n:
                        names[a][_norm_name(n)] += 1
                elif n:
                    name_only[_norm_name(n)] += 1
        best = None
        for addr, count in part.most_common(5):
            local = addr.split("@")[0].lower()
            full = next((nm for nm, _ in names[addr].most_common() if nm and "@" not in nm), "")
            if not full:
                full = next(
                    (
                        nm
                        for nm, _ in name_only.most_common()
                        if len(nm.split()) >= 2 and len(nm.split()[-1]) >= 3 and nm.split()[-1].lower() in local
                    ),
                    "",
                )
            score = count
            if full:
                first = full.split()[0].lower()
                score += sum(c for nm, c in name_only.items() if nm.lower() in (full.lower(), first))
            if best is None or score > best[0]:
                best = (score, addr, full)
        if best is None or best[0] < 0.5 * len(self.ordered):
            return None
        return {"name": best[2], "addr": best[1]}

    def resolve_names(self):
        """Fill in addresses for display-name-only recipients when the name is seen elsewhere with one."""
        seen = defaultdict(Counter)
        for r in self.ordered:
            for n, a in [r.p.from_, *r.p.to, *r.p.cc, *r.p.bcc, *r.p.reply_to]:
                if n and a:
                    seen[_norm_name(n).lower()][a] += 1
        known = {n: c.most_common(1)[0][0] for n, c in seen.items() if c.most_common(1)[0][1] >= 0.8 * sum(c.values())}
        owner = self.owner
        if owner and owner["name"]:
            known.setdefault(owner["name"].lower(), owner["addr"])
        first = owner["name"].split()[0].lower() if owner and owner["name"] else None
        fixed = 0

        def fix(lst, sole_to_owner=False):
            nonlocal fixed
            out = []
            for n, a in lst:
                if not a and n:
                    key = _norm_name(n).lower()
                    a2 = known.get(key) or (owner["addr"] if sole_to_owner and key == first else "")
                    if a2:
                        fixed += 1
                        a = a2
                out.append((n, a))
            return out

        for r in self.ordered:
            p = r.p
            p.from_ = fix([p.from_])[0]
            p.to = fix(p.to, sole_to_owner=len(p.to) == 1 and "Sent" not in r.labels)
            p.cc, p.bcc = fix(p.cc), fix(p.bcc)
        if fixed:
            log(f"filled {fixed} addresses for display-name-only recipients")

    # ---------- 3. tables ----------
    def write_tables(self):
        def js(v):
            return json.dumps(v, ensure_ascii=False, separators=(",", ":"))

        rows = []
        for r in self.ordered:
            p = r.p
            recips = "; ".join(f"{n} <{a}>" if n else a for n, a in p.to + p.cc + p.bcc).lower()
            text = self.db.execute("SELECT text FROM body WHERE key=?", (r.key,)).fetchone()[0] or ""
            atts_pub = [
                {k: a[k] for k in ("n", "t", "s", "p", "x", "k")} | ({"h": 1} if a.get("hidden") else {})
                for a in r.atts
            ]
            visible = [a for a in r.atts if not a.get("hidden")]
            rows.append(
                {
                    "doc": r.doc,
                    "id": r.id,
                    "thread_id": r.thread_id,
                    "ts": r.ts,
                    "date": p.date,
                    "from_name": p.from_[0],
                    "from_addr": p.from_[1],
                    "to_json": js(p.to),
                    "cc_json": js(p.cc),
                    "bcc_json": js(p.bcc),
                    "reply_to_json": js(p.reply_to),
                    "recipients": recips,
                    "subject": p.subject,
                    "snippet": snippet(clean_body(text, p.subject) or text),
                    "labels": r.labels,
                    "att_json": js(atts_pub),
                    "att_count": len(visible),
                    "has_att": bool(visible),
                    "att_names": " | ".join(a["n"] for a in visible).lower(),
                    "size": p.size,
                    "message_id": p.message_id or "",
                    "in_reply_to": " ".join(p.in_reply_to),
                    "refs": " ".join(p.references),
                    "doclen": 0.0,
                }
            )
        self.msg_rows = rows
        self.snippets = {r["doc"]: r["snippet"] for r in rows}

        trows = []
        by_doc = {r.doc: r for r in self.ordered}
        for members in self.threads:
            senders, seen = [], set()
            for r in members:
                n, a = r.p.from_
                k = a or n
                if k and k not in seen:
                    seen.add(k)
                    senders.append([n, a])
            atts = [{"n": a["n"], "t": a["t"], "p": a["p"]} for r in members for a in r.atts if not a.get("hidden")]
            # Gmail's Sent folder lists recipients ("To: Alice, Bob") instead of senders
            recips, rseen = [], set()
            sent = [r for r in members if "Sent" in r.labels] or members
            for r in sent:
                for n, a in r.p.to + r.p.cc:
                    k = a or n
                    if k and k not in rseen:
                        rseen.add(k)
                        recips.append([n, a])
            last = members[-1]
            trows.append(
                {
                    "thread_id": last.thread_id,
                    "subject": _thread_subject(members),
                    "first_ts": members[0].ts,
                    "last_ts": max((r.ts or 0) for r in members) or None,
                    "count": len(members),
                    "senders_json": js(senders),
                    "recipients_json": js(recips[:10]),
                    "snippet": self.snippets[last.doc],
                    "has_att": bool(atts),
                    "att_json": js(atts[:6]),
                    "att_count": len(atts),
                    "labels": sorted({label for r in members for label in r.labels}),
                    "docs": [r.doc for r in members],
                }
            )
        self.thread_rows = trows
        del by_doc

    def index(self):
        """Inverted index (term → doc, weighted tf) and bigram phrase index, sorted by term."""
        spool = self.work / "postings"
        spool.mkdir()
        buf_u, buf_p = defaultdict(list), defaultdict(list)
        part = 0
        total_len = 0.0

        def flush():
            nonlocal part, buf_u, buf_p
            for name, buf in (("u", buf_u), ("p", buf_p)):
                if buf["term"]:
                    pq.write_table(
                        pa.table(
                            {
                                "term": pa.array(buf["term"], pa.string()),
                                "doc": pa.array(buf["doc"], pa.int32()),
                                "tf": pa.array(buf["tf"], pa.float32()),
                            }
                        ),
                        spool / f"{name}-{part:05d}.parquet",
                    )
            part += 1
            buf_u, buf_p = defaultdict(list), defaultdict(list)

        def atext(sha):
            return (self.db.execute("SELECT text FROM atext WHERE sha=?", (sha,)).fetchone() or [""])[0] or ""

        for r, row in zip(self.ordered, self.msg_rows):
            p = r.p
            text = self.db.execute("SELECT text FROM body WHERE key=?", (r.key,)).fetchone()[0] or ""
            fields = [
                (p.subject, W["subject"], True),
                (" ".join(f"{n} {a}" for n, a in [p.from_, *p.to, *p.cc, *p.bcc]), W["people"], False),
                (urls_to_hosts(text), W["body"], True),
            ]
            for a in r.atts:
                if a.get("hidden"):
                    continue
                fields.append((a["n"], W["attachment_name"], False))
                if a["x"]:
                    fields.append((urls_to_hosts(atext(a["sha"])[:MAX_INDEX_ATT_CHARS]), W["attachment_text"], True))
            uni, bi = Counter(), Counter()
            for s, w, phrases in fields:
                toks = tokenize(s)
                for t in toks:
                    if t not in STOPWORDS:
                        uni[t] += w
                if phrases:
                    for a, b in itertools.pairwise(toks):
                        bi[f"{a} {b}"] += 1
            dl = float(sum(uni.values()))
            row["doclen"] = dl
            total_len += dl
            for buf, counts in ((buf_u, uni), (buf_p, bi)):
                for t, tf in counts.items():
                    buf["term"].append(t)
                    buf["doc"].append(r.doc)
                    buf["tf"].append(tf)
            if len(buf_u["term"]) + len(buf_p["term"]) > 2_000_000:
                flush()
        flush()
        self.avg_len = total_len / max(1, len(self.ordered))

        con = duckdb.connect()
        con.execute("SET preserve_insertion_order=false")
        self.index_rows = {}
        for name, out in (("u", "postings"), ("p", "phrases")):
            files = sorted(spool.glob(f"{name}-*.parquet"))
            dest = self.ds / f"{out}.parquet"
            if not files:
                pq.write_table(
                    pa.table(
                        {
                            "term": pa.array([], pa.string()),
                            "doc": pa.array([], pa.int32()),
                            "tf": pa.array([], pa.float32()),
                        }
                    ),
                    dest,
                )
                self.index_rows[out] = 0
                continue
            glob = str(spool / f"{name}-*.parquet")
            con.execute(
                f"COPY (SELECT term, doc, tf FROM read_parquet('{glob}') ORDER BY term, doc) "
                f"TO '{dest}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 32768)"
            )
            self.index_rows[out] = con.execute(f"SELECT count(*) FROM '{dest}'").fetchone()[0]
        con.close()
        log(f"search index: {self.index_rows['postings']:,} postings, {self.index_rows['phrases']:,} phrase postings")

    def write_parquet(self):
        msg_schema = pa.schema(
            [
                ("doc", pa.int32()),
                ("id", pa.string()),
                ("thread_id", pa.string()),
                ("ts", pa.int64()),
                ("date", pa.timestamp("ms", tz="UTC")),
                ("from_name", pa.string()),
                ("from_addr", pa.string()),
                ("to_json", pa.string()),
                ("cc_json", pa.string()),
                ("bcc_json", pa.string()),
                ("reply_to_json", pa.string()),
                ("recipients", pa.string()),
                ("subject", pa.string()),
                ("snippet", pa.string()),
                ("labels", pa.list_(pa.string())),
                ("att_json", pa.string()),
                ("att_names", pa.string()),
                ("att_count", pa.int16()),
                ("has_att", pa.bool_()),
                ("size", pa.int32()),
                ("doclen", pa.float32()),
                ("message_id", pa.string()),
                ("in_reply_to", pa.string()),
                ("refs", pa.string()),
            ]
        )
        pq.write_table(
            pa.Table.from_pylist(self.msg_rows, msg_schema),
            self.ds / "messages.parquet",
            compression="zstd",
            row_group_size=50_000,
        )
        thr_schema = pa.schema(
            [
                ("thread_id", pa.string()),
                ("subject", pa.string()),
                ("first_ts", pa.int64()),
                ("last_ts", pa.int64()),
                ("count", pa.int32()),
                ("senders_json", pa.string()),
                ("recipients_json", pa.string()),
                ("snippet", pa.string()),
                ("has_att", pa.bool_()),
                ("att_json", pa.string()),
                ("att_count", pa.int32()),
                ("labels", pa.list_(pa.string())),
                ("docs", pa.list_(pa.int32())),
            ]
        )
        pq.write_table(
            pa.Table.from_pylist(self.thread_rows, thr_schema),
            self.ds / "threads.parquet",
            compression="zstd",
            row_group_size=50_000,
        )

        # bodies: sorted by thread so opening a conversation reads one small row group
        body_schema = pa.schema(
            [
                ("thread_id", pa.string()),
                ("doc", pa.int32()),
                ("id", pa.string()),
                ("message_id", pa.string()),
                ("reply_to_json", pa.string()),
                ("snippet", pa.string()),
                ("text", pa.string()),
                ("html", pa.string()),
                ("headers", pa.string()),
            ]
        )
        extra = {r["doc"]: r for r in self.msg_rows}
        cur = self.db.execute(
            "SELECT o.thread_id, o.doc, o.id, b.text, b.html, b.headers FROM body b "
            "JOIN ord o USING(key) ORDER BY o.thread_id, o.ts"
        )
        _write_grouped(
            self.ds / "bodies.parquet",
            body_schema,
            (
                {
                    "thread_id": t,
                    "doc": d,
                    "id": i,
                    "message_id": extra[d]["message_id"],
                    "reply_to_json": extra[d]["reply_to_json"],
                    "snippet": extra[d]["snippet"],
                    "text": tx,
                    "html": h,
                    "headers": hd,
                }
                for t, d, i, tx, h, hd in cur
            ),
            key="thread_id",
            stats=("thread_id", "doc", "id"),
        )

        att_schema = pa.schema(
            [
                ("id", pa.string()),
                ("doc", pa.int32()),
                ("idx", pa.int16()),
                ("name", pa.string()),
                ("mime", pa.string()),
                ("size", pa.int64()),
                ("sha256", pa.string()),
                ("path", pa.string()),
                ("hidden", pa.bool_()),
                ("text", pa.string()),
            ]
        )

        def att_rows():
            for r in sorted(self.ordered, key=lambda r: r.id):
                for a in r.atts:
                    t = self.db.execute("SELECT text FROM atext WHERE sha=?", (a["sha"],)).fetchone()
                    yield {
                        "id": r.id,
                        "doc": r.doc,
                        "idx": a["k"],
                        "name": a["n"],
                        "mime": a["t"],
                        "size": a["s"],
                        "sha256": a["sha"],
                        "path": a["p"],
                        "hidden": bool(a.get("hidden")),
                        "text": (t[0] if t else None) or None,
                    }

        _write_grouped(self.ds / "attachments.parquet", att_schema, att_rows(), key="id", stats=("id", "doc", "idx"))
        self.stats["attachments"] = sum(1 for r in self.ordered for a in r.atts if not a.get("hidden"))

    # ---------- 4. embeddings ----------
    def embed(self):
        texts, owners = [], []
        size, overlap = EMB["chunk_words"], EMB["overlap_words"]

        def atext(sha):
            return (self.db.execute("SELECT text FROM atext WHERE sha=?", (sha,)).fetchone() or [""])[0] or ""

        for r in self.ordered:
            p = r.p
            text = self.db.execute("SELECT text FROM body WHERE key=?", (r.key,)).fetchone()[0] or ""
            head = f"{p.subject}\nFrom: {p.from_[0] or p.from_[1]}\n"
            body = urls_to_hosts(clean_body(text, p.subject))
            chunks = chunk_words(body, size, overlap, EMB["max_body_chunks"]) or [""]
            for i, c in enumerate(chunks):
                texts.append((head + c) if i == 0 else f"{p.subject}\n{c}")
                owners.append((r.doc, -1))
            for a in r.atts:
                if a.get("hidden") or not a["x"]:
                    continue
                for c in chunk_words(urls_to_hosts(atext(a["sha"])), size, overlap, EMB["max_attachment_chunks"]):
                    texts.append(f"Attachment {a['n']} (email: {p.subject})\n{c}")
                    owners.append((r.doc, a["k"]))
        vec_path = self.ds / "vectors.bin"
        embed_chunks(texts, vec_path, self.work)
        pq.write_table(
            pa.table(
                {
                    "doc": pa.array([o[0] for o in owners], pa.int32()),
                    "src": pa.array([o[1] for o in owners], pa.int16()),
                }
            ),
            self.ds / "chunks.parquet",
            compression="zstd",
        )
        self.chunk_count = len(texts)

    # ---------- 5. manifest ----------
    def finish(self):
        files = {}
        for name in ("messages", "threads", "bodies", "attachments", "postings", "phrases", "chunks"):
            if (self.ds / f"{name}.parquet").exists():  # no chunks without embeddings
                files[name] = _hash_name(self.ds / f"{name}.parquet")
        if (self.ds / "vectors.bin").exists():
            files["vectors"] = _hash_name(self.ds / "vectors.bin")

        # prune attachments no longer referenced
        att_root = self.ds / "att"
        if att_root.exists():
            for f in att_root.rglob("*"):
                if f.is_file() and str(f.relative_to(self.ds)) not in self.att_paths:
                    f.unlink()
            for d in sorted(att_root.glob("*"), reverse=True):
                if d.is_dir() and not any(d.iterdir()):
                    d.rmdir()

        label_counts = Counter(label for r in self.ordered for label in r.labels)
        people = Counter()
        names = defaultdict(Counter)
        owner = self.owner["addr"] if self.owner else None
        for r in self.ordered:
            for n, a in {(n, a) for n, a in [r.p.from_, *r.p.to, *r.p.cc]}:
                key = a or n
                if key and a != owner:
                    people[key] += 1
                    if n:
                        names[key][n] += 1
        ts = [r.ts for r in self.ordered if r.ts]
        manifest = {
            "format": FORMAT_VERSION,
            "generator": f"mailbox-viewer {__version__}",
            "slug": self.slug,
            "title": self.title
            or _unique_title(
                self.out, self.slug, (self.owner and (self.owner["name"] or self.owner["addr"])) or self.slug
            ),
            "description": self.description,
            "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "owner": self.owner,
            "counts": {
                "messages": len(self.ordered),
                "threads": len(self.threads),
                "attachments": self.stats["attachments"],
                "duplicates_merged": self.stats["duplicates"],
                "parse_errors": self.stats["parse_errors"],
            },
            "date_range": [min(ts), max(ts)] if ts else None,
            "labels": [
                {"name": name, "count": n} for name, n in sorted(label_counts.items(), key=lambda x: (-x[1], x[0]))
            ],
            "people": [
                {"addr": k if "@" in k else "", "name": names[k].most_common(1)[0][0] if names[k] else "", "count": n}
                for k, n in people.most_common(100)
            ],
            "files": files,
            "search": {
                "docs": len(self.ordered),
                "avg_len": round(self.avg_len, 3),
                "k1": BM25["k1"],
                "b": BM25["b"],
                "tokenizer": SHARED["tokenizer"]["version"],
                **self.index_rows,
            },
            "embedding": (
                {k: EMB[k] for k in ("model", "dtype", "pooling", "query_prefix", "dims", "min_score")}
                | {"count": self.chunk_count}
            )
            if files.get("vectors")
            else None,
        }
        (self.ds / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
        update_index(self.out, manifest, hidden=self.hidden)
        return manifest

    def run(self):
        t0 = time.time()
        steps = []

        def step(name, fn):
            t = time.time()
            fn()
            steps.append(f"{name} {time.time() - t:.0f}s")

        step("parse", self.parse)
        step("threads", self.organize)
        self.owner = self.detect_owner()
        self.resolve_names()
        step("tables", self.write_tables)
        step("index", self.index)
        step("parquet", self.write_parquet)
        self.chunk_count = 0
        if self.do_embed:
            step("embed", self.embed)
        m = self.finish()
        self.db.close()
        self.cache_db.close()
        size = sum(f.stat().st_size for f in self.ds.rglob("*") if f.is_file())
        log(f"done in {time.time() - t0:.0f}s ({', '.join(steps)}) → {self.ds}  ({size / 1e6:.1f} MB)")
        return m


def _write_grouped(path: Path, schema: pa.Schema, rows, key: str, stats: tuple[str, ...], target_bytes: int = 768_000):
    """Write row groups of roughly target_bytes (uncompressed), never splitting a key across groups
    unless a single key is much larger than the target. Min/max statistics only for the lookup columns:
    on long text columns they bloat the footer every reader downloads first."""
    writer = pq.ParquetWriter(path, schema, compression="zstd", write_statistics=list(stats))
    batch, size, last = [], 0, None
    wrote = False
    for row in rows:
        k = row[key]
        if batch and ((size >= target_bytes and k != last) or size >= 4 * target_bytes):
            writer.write_table(pa.Table.from_pylist(batch, schema))
            wrote = True
            batch, size = [], 0
        batch.append(row)
        size += sum(len(v) for v in row.values() if isinstance(v, str))
        last = k
    if batch or not wrote:
        writer.write_table(pa.Table.from_pylist(batch, schema))
    writer.close()


def _hash_name(path: Path) -> str:
    h = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
    new = path.with_name(f"{path.stem}.{h}{path.suffix}")
    path.rename(new)
    return new.name


def build(inputs, slug, out, **kw):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", slug):
        sys.exit("slug must be lowercase letters, digits and dashes (it becomes the URL path)")
    return Builder([Path(i) for i in inputs], slug, Path(out), **kw).run()
