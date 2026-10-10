"""Group messages into conversations.

Order of evidence: References/In-Reply-To, Outlook Thread-Index, then (for messages whose subject
has a reply/forward prefix) the most recent earlier message with the same normalized subject and an
overlapping participant within 120 days. PST exports often carry none of the headers, so the subject
rule does most of the work there; identical newsletter subjects without "Re:" stay separate.
"""

from collections import defaultdict
from datetime import timedelta

from .textutil import has_reply_prefix, normalize_subject

GENERIC_SUBJECTS = {
    "",
    "(no subject)",
    "no subject",
    "untitled",
    "hi",
    "hello",
    "hey",
    "test",
    "question",
    "thanks",
    "thank you",
}
WINDOW = timedelta(days=120)


class _UF:
    def __init__(self):
        self.parent: dict = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def assign_threads(msgs: list) -> list[int]:
    """msgs: objects with .message_id .in_reply_to .references .thread_index .subject .date .participants.
    Returns a group number per message."""
    uf = _UF()
    for i, m in enumerate(msgs):
        node = ("m", i)
        uf.find(node)
        if m.message_id:
            uf.union(("id", m.message_id), node)
        for ref in [*m.references, *m.in_reply_to]:
            uf.union(("id", ref), node)
        if m.thread_index:
            uf.union(("ti", m.thread_index), node)

    by_subject = defaultdict(list)
    for i, m in enumerate(msgs):
        s = normalize_subject(m.subject)
        if s not in GENERIC_SUBJECTS and len(s) > 2:
            by_subject[s].append(i)
    for idxs in by_subject.values():
        if len(idxs) < 2:
            continue
        idxs.sort(key=lambda i: (msgs[i].date is None, msgs[i].date))
        for pos, i in enumerate(idxs):
            m = msgs[i]
            if not has_reply_prefix(m.subject) or m.date is None:
                continue
            for j in reversed(idxs[:pos]):
                o = msgs[j]
                if o.date is None or m.date - o.date > WINDOW:
                    break
                if m.participants & o.participants:
                    uf.union(("m", j), ("m", i))
                    break

    roots, out = {}, []
    for i in range(len(msgs)):
        r = uf.find(("m", i))
        out.append(roots.setdefault(r, len(roots)))
    return out
