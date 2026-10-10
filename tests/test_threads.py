from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from mailbox_viewer.threads import assign_threads

T0 = datetime(2024, 1, 1, tzinfo=UTC)


@dataclass
class M:
    subject: str
    days: int = 0
    message_id: str | None = None
    in_reply_to: list = field(default_factory=list)
    references: list = field(default_factory=list)
    thread_index: str | None = None
    participants: frozenset = frozenset({"a@x.com", "b@x.com"})

    @property
    def date(self):
        return T0 + timedelta(days=self.days)


def test_references_link_messages():
    g = assign_threads([M("Budget", 0, "1"), M("Re: Budget", 1, "2", ["1"]), M("Other", 2, "3")])
    assert g[0] == g[1] != g[2]


def test_subject_fallback_needs_reply_prefix():
    msgs = [M("Tree removal", 0), M("RE: Tree removal", 1), M("Re: RE: Tree removal", 3)]
    g = assign_threads(msgs)
    assert len(set(g)) == 1


def test_identical_newsletters_stay_separate():
    msgs = [M("Parks Weekly", d) for d in (0, 7, 14)]
    assert len(set(assign_threads(msgs))) == 3


def test_subject_fallback_respects_window_and_participants():
    far = [M("Plan", 0), M("Re: Plan", 400)]
    assert len(set(assign_threads(far))) == 2
    strangers = [M("Plan", 0), M("Re: Plan", 1, participants=frozenset({"z@y.com"}))]
    assert len(set(assign_threads(strangers))) == 2


def test_generic_subjects_never_merge():
    assert len(set(assign_threads([M("Hi", 0), M("Re: Hi", 1)]))) == 2
