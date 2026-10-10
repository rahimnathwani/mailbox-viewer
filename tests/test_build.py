import duckdb
import pyarrow.parquet as pq
from conftest import make_message, table, write_mbox

from mailbox_viewer.build import build
from mailbox_viewer.parse import parse_message


def test_manifest(demo):
    ds, m = demo
    assert m["counts"] == {
        "messages": 19,
        "threads": 14,
        "attachments": m["counts"]["attachments"],
        "duplicates_merged": 1,
        "parse_errors": 0,
    }
    assert m["owner"]["addr"] == "dana.whitfield@parks.example.gov"
    labels = {lab["name"] for lab in m["labels"]}
    assert labels == {"Inbox", "Sent", "Spam", "Trash", "Projects/Playground"}
    assert m["embedding"] is None and "vectors" not in m["files"]
    assert (ds.parent / "datasets.json").exists()


def test_threads_and_labels(demo):
    ds, m = demo
    con = duckdb.connect()
    rows = dict(con.sql(f"SELECT subject, count FROM '{table(ds, m, 'threads')}'").fetchall())
    assert rows["Playground renovation budget"] == 4
    assert rows["Tree removal request on Elm St"] == 3
    assert sum(1 for s in rows if s.startswith("Parks Weekly")) == 1  # one subject key...
    weekly = con.sql(f"SELECT count(*) FROM '{table(ds, m, 'threads')}' WHERE subject LIKE 'Parks Weekly%'").fetchone()[
        0
    ]
    assert weekly == 3  # ...but three separate conversations
    dup = con.sql(
        f"SELECT labels FROM '{table(ds, m, 'messages')}' WHERE subject = 'Thank you for the park tour'"
    ).fetchall()
    assert len(dup) == 1 and sorted(dup[0][0]) == ["Inbox", "Projects/Playground"]


def test_resolved_display_names(demo):
    ds, m = demo
    con = duckdb.connect()
    to = con.sql(f"SELECT to_json FROM '{table(ds, m, 'messages')}' WHERE subject = 'Staff meeting notes'").fetchone()[
        0
    ]
    assert '"dana.whitfield@parks.example.gov"' in to  # "Whitfield, Dana" matched to the owner
    assert '"priya.n@parks.example.gov"' in to


def test_attachments_and_extracted_text(demo):
    ds, m = demo
    con = duckdb.connect()
    att = {
        r[0]: r
        for r in con.sql(f"SELECT name, mime, hidden, text, path FROM '{table(ds, m, 'attachments')}'").fetchall()
    }
    assert "48,500" in att["budget-2024.pdf"][3]
    assert "BlueLine Pools" in att["pool-bids.xlsx"][3]
    assert "seven weeks" in att["contract-draft.docx"][3]
    assert att["map.png"][2] is True  # inline image referenced from HTML
    assert "Budget hearing moved" in att["Budget hearing moved to April 18.eml"][3]
    for name, *_rest, path in att.values():
        assert (ds / "att" / path.split("/")[1] / name).exists()
    html = con.sql(f"SELECT html FROM '{table(ds, m, 'bodies')}' WHERE html LIKE '%park map%'").fetchone()[0]
    assert "mbv-att:att/" in html and "cid:map001" not in html


def test_postings_sorted_with_row_group_stats(demo):
    ds, m = demo
    f = pq.ParquetFile(table(ds, m, "postings"))
    terms = f.read(columns=["term"]).column("term").to_pylist()
    assert terms == sorted(terms)
    st = f.metadata.row_group(0).column(0).statistics
    assert st is not None and st.has_min_max  # lets DuckDB skip row groups over HTTP
    con = duckdb.connect()
    docs = con.sql(
        f"SELECT count(DISTINCT doc) FROM '{table(ds, m, 'postings')}' WHERE term = 'playground'"
    ).fetchone()[0]
    assert docs >= 3
    phrase = con.sql(f"SELECT count(*) FROM '{table(ds, m, 'phrases')}' WHERE term = 'safety surfacing'").fetchone()[0]
    assert phrase >= 1


def test_bodies_grouped_by_thread(demo):
    ds, m = demo
    f = pq.ParquetFile(table(ds, m, "bodies"))
    tids = f.read(columns=["thread_id"]).column("thread_id").to_pylist()
    assert tids == sorted(tids)


def test_snippets_are_clean(demo):
    ds, m = demo
    con = duckdb.connect()
    for (s,) in con.sql(f"SELECT snippet FROM '{table(ds, m, 'messages')}'").fetchall():
        assert "http" not in s and "\n" not in s


def test_duplicates_with_attachments_merge_and_shared_attachments_dont(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    same = b"a,b\n1,2\n"
    write_mbox(
        src / "Inbox.mbox", [make_message("<1@x>", "first", att=same), make_message("<2@x>", "second", att=same)]
    )
    write_mbox(src / "Trash.mbox", [make_message("<1@x>", "first", att=same)])
    m = build([src], "t", tmp_path / "dist", embed=False)
    assert m["counts"]["messages"] == 2 and m["counts"]["duplicates_merged"] == 1
    rows = duckdb.sql(
        f"SELECT subject, labels FROM '{tmp_path}/dist/t/{m['files']['messages']}' ORDER BY subject"
    ).fetchall()
    assert rows == [("first", ["Inbox", "Trash"]), ("second", ["Inbox"])]


def test_raw_8bit_headers_dont_crash_the_build(tmp_path):
    raw = "From: a@x.com\r\nTo: Müller, Hans; Jack\r\nSubject: Grüße\r\n\r\nhi\r\n".encode()
    p = parse_message(raw)
    assert p.to == [("Müller, Hans", ""), ("Jack", "")]
    latin = "From: a@x.com\r\nTo: Müller, Hans; Jack\r\n\r\nhi\r\n".encode("latin-1")
    assert parse_message(latin).to[0] == ("Müller, Hans", "")
    src = tmp_path / "in"
    src.mkdir()
    (src / "m.eml").write_bytes(raw)
    build([src], "t", tmp_path / "dist", embed=False)  # must not raise


def test_thread_subject_comes_from_the_opening_message_and_titles_stay_unique(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    orig = make_message("<orig@x>", "connecting you two")
    orig.replace_header("Date", "Thu, 24 Feb 2022 04:30:00 +0000")
    reply = make_message("<reply@x>", "Re: connecting you two")
    reply.replace_header("Date", "Wed, 23 Feb 2022 20:52:00 +0000")  # sender's clock says before the original
    reply["In-Reply-To"] = "<orig@x>"
    write_mbox(src / "Inbox.mbox", [orig, reply])
    dist = tmp_path / "dist"
    m = build([src], "one", dist, embed=False)
    subj = duckdb.sql(f"SELECT subject FROM '{dist}/one/{m['files']['threads']}'").fetchall()
    assert subj == [("connecting you two",)]
    m2 = build([src], "two", dist, embed=False)
    assert m["title"] != m2["title"] and m2["title"].endswith("(two)")
