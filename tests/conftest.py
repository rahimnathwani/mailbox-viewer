import json
import mailbox
from email.message import EmailMessage
from pathlib import Path

import pytest

from mailbox_viewer.build import build

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def demo(tmp_path_factory) -> tuple[Path, dict]:
    """The fictional demo mailbox built once (keyword index only, no model download)."""
    out = tmp_path_factory.mktemp("dist")
    manifest = build([FIXTURES / "demo"], "demo", out, title="Demo", embed=False)
    return out / "demo", manifest


def table(ds: Path, manifest: dict, name: str) -> str:
    return str(ds / manifest["files"][name])


@pytest.fixture
def read_json():
    return lambda p: json.loads(Path(p).read_text())


def make_message(mid, subject, body="hello", att=None):
    m = EmailMessage()
    m["From"] = "a@x.com"
    m["To"] = "b@x.com"
    m["Subject"] = subject
    m["Date"] = "Mon, 1 Jan 2024 10:00:00 +0000"
    m["Message-ID"] = mid
    m.set_content(body)
    if att:
        m.add_attachment(att, maintype="text", subtype="csv", filename="data.csv")
    return m


def write_mbox(path, msgs):
    mb = mailbox.mbox(path, create=True)
    for m in msgs:
        mb.add(m)
    mb.flush()
    mb.close()
