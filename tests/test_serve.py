import threading
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer

from mailbox_viewer.serve import Handler


def test_range_requests_and_spa_fallback(tmp_path):
    viewer, data = tmp_path / "viewer", tmp_path / "data"
    viewer.mkdir()
    data.mkdir()
    (viewer / "index.html").write_text("<html>app</html>")
    (data / "f.bin").write_bytes(bytes(range(256)))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, viewer=viewer, data=data))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        r = urllib.request.urlopen(urllib.request.Request(base + "/data/f.bin", headers={"Range": "bytes=10-19"}))
        assert r.status == 206 and r.read() == bytes(range(10, 20))
        assert r.headers["Content-Range"] == "bytes 10-19/256"
        r = urllib.request.urlopen(urllib.request.Request(base + "/data/f.bin", headers={"Range": "bytes=-6"}))
        assert r.read() == bytes(range(250, 256))
        r = urllib.request.urlopen(urllib.request.Request(base + "/data/f.bin", method="HEAD"))
        assert r.headers["Content-Length"] == "256" and r.headers["Accept-Ranges"] == "bytes"
        assert urllib.request.urlopen(base + "/some-slug").read() == b"<html>app</html>"
        try:
            urllib.request.urlopen(base + "/data/../../etc/passwd")
            raise AssertionError("path traversal not blocked")
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        httpd.shutdown()


def test_active_attachment_types_are_served_inert(tmp_path):
    viewer, data = tmp_path / "viewer", tmp_path / "data"
    (viewer).mkdir()
    att = data / "ds" / "att" / "abc"
    att.mkdir(parents=True)
    (viewer / "index.html").write_text("app")
    (att / "invoice.html").write_text("<script>alert(1)</script>")
    (att / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    (att / "report.pdf").write_bytes(b"%PDF-1.4")
    (att / "x.html.gz").write_bytes(b"<script>alert(1)</script>")
    (att / "page.xhtml").write_text("<html xmlns='http://www.w3.org/1999/xhtml'><script>alert(1)</script></html>")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, viewer=viewer, data=data))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/data/ds/att/abc/"
    try:
        h = urllib.request.urlopen(base + "invoice.html").headers
        assert h["Content-Type"].startswith("text/plain") and h["X-Content-Type-Options"] == "nosniff"
        h = urllib.request.urlopen(base + "logo.svg").headers
        assert h["Content-Type"] == "image/svg+xml" and h["Content-Disposition"] == "attachment"
        assert urllib.request.urlopen(base + "report.pdf").headers["Content-Type"] == "application/pdf"
        h = urllib.request.urlopen(base + "x.html.gz").headers
        assert h["Content-Type"] == "application/octet-stream" and h["Content-Disposition"] == "attachment"
        assert urllib.request.urlopen(base + "page.xhtml").headers["Content-Type"].startswith("text/plain")
    finally:
        httpd.shutdown()
