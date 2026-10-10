"""Text helpers: tokenizer, HTML to text, quote/signature trimming, snippets, chunking.

`tokenize` must stay identical to viewer/src/search/tokenize.js; tests/test_tokenizer_parity.py
runs both over the same strings.
"""

import re
import unicodedata

import regex
from selectolax.lexbor import LexborHTMLParser

from .config import SHARED

_TOK = SHARED["tokenizer"]
MAX_TOKEN = _TOK["max_token_length"]
STOPWORDS = frozenset(_TOK["stopwords"])

_MARKS = regex.compile(r"[\u0300-\u036f]+")  # Latin/Greek/Cyrillic accents; kana voicing, Indic vowel signs stay
_TOKEN = regex.compile(r"[\p{L}\p{N}\p{M}]+")
_CJK = regex.compile(r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]")
_CJK_SPLIT = regex.compile(
    r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{M}]*|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+"
)


def normalize(s: str) -> str:
    return unicodedata.normalize("NFC", _MARKS.sub("", unicodedata.normalize("NFKD", s))).lower()


def tokenize(s: str) -> list[str]:
    """Lowercased, accent-folded letter/digit runs; CJK characters become single tokens."""
    out = []
    for m in _TOKEN.finditer(normalize(s)):
        t = m.group()
        if _CJK.search(t):
            out.extend(p.group() for p in _CJK_SPLIT.finditer(t) if len(p.group()) <= MAX_TOKEN)
        elif len(t) <= MAX_TOKEN:
            out.append(t)
    return out


# ---------- cleanup ----------

# zero-width and other invisible characters marketing emails use as preheader padding
_INVISIBLE = re.compile("[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]")
_URL = re.compile(r"https?://([^/\s<>\"')\]]+)[^\s<>\"')\]]*", re.I)


def strip_invisible(s: str) -> str:
    return _INVISIBLE.sub("", s).replace(" ", " ")


def collapse_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def tidy_text(s: str) -> str:
    """Normalise newlines, drop invisible padding, trim trailing spaces, cap blank lines at one."""
    s = strip_invisible(s.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [re.sub(r"[ \t\f\v]+", " ", ln).strip() for ln in s.split("\n")]
    s = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def urls_to_hosts(s: str) -> str:
    """Tracking URLs flood the index with junk tokens; keep only the host name."""
    return _URL.sub(lambda m: m.group(1), s)


_BLOCK_END = re.compile(
    r"(?i)</(p|div|tr|li|ul|ol|h[1-6]|table|blockquote|section|article|header|footer|pre|center|dt|dd)\s*>"
)


def html_to_text(html: str) -> str:
    if not html:
        return ""
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = _BLOCK_END.sub("\n", html)
    html = re.sub(r"(?i)</t[dh]\s*>", " ", html)
    try:
        tree = LexborHTMLParser(html)
    except Exception:
        return tidy_text(re.sub(r"<[^>]+>", " ", html))
    for node in tree.css("style, script, head, title, noscript, template"):
        node.decompose()
    root = tree.body or tree.root
    text = root.text(deep=True, separator="", strip=False) if root else ""
    return tidy_text(text)


# ---------- reply trimming ----------

_QUOTE_HEADERS = [
    re.compile(r"^On\b[^\n]{0,300}(?:\n[^\n]{0,200})?\bwrote:\s*$", re.M),  # Gmail/Apple, may wrap over 2 lines
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}", re.M | re.I),
    re.compile(r"^_{8,}\s*\n\s*From:", re.M),  # Outlook HTML rendered as text
    re.compile(r"^From:\s.+\n(?:.+\n){0,3}?(?:Sent|Date):\s.+\n(?:.+\n){0,4}?Subject:", re.M),
    re.compile(r"^Le .{0,200}a écrit\s?:\s*$", re.M),
    re.compile(r"^Am .{0,200}schrieb .{0,200}:\s*$", re.M),
    re.compile(r"^El .{0,200}escribió:\s*$", re.M),
]
_SIG = re.compile(r"^-- ?$", re.M)
_SENT_FROM = re.compile(r"^(Sent from my .{1,40}|Get Outlook for .{1,30}|Sent from Mail for Windows.*)$", re.M | re.I)


_FWD = re.compile(r"^(-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:|-{2,}\s*Forwarded by)", re.M | re.I)
_FWD_SUBJECT = re.compile(r"^\s*(fw|fwd|wg|tr|enc)\s*:", re.I)


def split_reply(text: str) -> tuple[str, str]:
    """Split a plain-text body into (new content, quoted history). Forwarded content counts as new."""
    cut = len(text)
    for pat in _QUOTE_HEADERS:
        m = pat.search(text)
        if m and m.start() < cut and m.start() > 0:
            cut = m.start()
    # a trailing block of ">" lines (inline answers between quotes are new content, so leave those)
    m = re.search(r"^>.*(?:\n>.*)+", text, re.M)
    if m and 0 < m.start() < cut:
        rest = text[m.end() :]
        sig = _SIG.search(rest)
        rest = _SENT_FROM.sub("", rest[: sig.start()] if sig else rest)
        if not re.search(r"^(?!>)\S", rest, re.M):
            cut = m.start()
    fwd = _FWD.search(text)
    if fwd and fwd.start() <= cut:
        return text, ""
    return text[:cut].rstrip(), text[cut:].lstrip()


def clean_body(text: str, subject: str = "") -> str:
    """New content only: no quoted history, signature delimiter tail or 'Sent from my iPhone'.
    Forwards keep the forwarded message, which is usually the substance."""
    new = text if _FWD_SUBJECT.match(subject or "") else split_reply(text)[0]
    m = _SIG.search(new)
    if m and m.start() > 0:
        new = new[: m.start()]
    new = _SENT_FROM.sub("", new)
    new = "\n".join(ln for ln in new.split("\n") if not ln.startswith(">"))  # quoted lines between inline answers
    return tidy_text(new)


def snippet(text: str, n: int = 200) -> str:
    """Preview line: links and link residue removed ("View in browser (https://...)" → "View in browser")."""
    s = re.sub(r"<(?:https?|mailto):[^>]*>", "", text, flags=re.I)
    s = re.sub(r"[(\[]\s*(?:https?|mailto|cid):[^)\]]*[)\]]", "", s, flags=re.I)
    s = re.sub(r"(?:https?|mailto)(?::|%3A)\S*", "", s, flags=re.I)
    s = re.sub(r"[(\[]\s*[)\]]", "", s)
    return collapse_ws(s)[:n]


def chunk_words(text: str, size: int, overlap: int, limit: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    step = max(1, size - overlap)
    out = []
    for start in range(0, len(words), step):
        out.append(" ".join(words[start : start + size]))
        if start + size >= len(words) or len(out) >= limit:
            break
    return out


_PREFIX = re.compile(r"^\s*((re|fw|fwd|aw|wg|sv|vs|rif|tr|antw|odp|res|enc|r)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*)+", re.I)
_TAGS = re.compile(r"^\s*(\[(external|ext|ext\.|caution|warning|spam|suspected spam|secure)\]\s*)+", re.I)


def has_reply_prefix(subject: str) -> bool:
    return bool(_PREFIX.match(_TAGS.sub("", subject or "")))


def normalize_subject(subject: str) -> str:
    s = subject or ""
    for _ in range(5):
        new = _PREFIX.sub("", _TAGS.sub("", s))
        if new == s:
            break
        s = new
    return collapse_ws(s).casefold()
