import mailbox

from conftest import make_message

from mailbox_viewer.ingest import discover


def test_maildir_plus_plus(tmp_path):
    root = tmp_path / "Maildir"
    for d in (root, root / ".Sent", root / ".Archive.2020"):
        md = mailbox.Maildir(d, create=True)
        md.add(make_message(f"<{d.name}@x>", d.name))
    labels = sorted(s.label for s in discover([root]))
    assert labels == ["Archive/2020", "Inbox", "Sent"]


def test_maildir_plus_plus_under_a_parent_folder(tmp_path):
    root = tmp_path / "accounts" / "alice"
    root.parent.mkdir()
    for d in (root, root / ".Sent"):
        mailbox.Maildir(d, create=True).add(make_message(f"<{d.name}@x>", d.name))
    assert sorted(s.label for s in discover([tmp_path / "accounts"])) == ["Inbox", "Sent"]
