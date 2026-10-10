"""Parse one raw RFC 822 message into plain fields: addresses, dates, bodies, attachments."""

import base64
import email.utils
import hashlib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email import policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser

from .textutil import collapse_ws, html_to_text, tidy_text

_PARSER = BytesParser(policy=policy.default)


@dataclass
class Attachment:
    name: str
    mime: str
    data: bytes
    inline: bool = False
    cid: str | None = None

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass
class Parsed:
    message_id: str | None
    in_reply_to: list[str]
    references: list[str]
    thread_index: str | None
    date: datetime | None
    from_: tuple[str, str]
    to: list[tuple[str, str]]
    cc: list[tuple[str, str]]
    bcc: list[tuple[str, str]]
    reply_to: list[tuple[str, str]]
    subject: str
    text: str
    html: str | None
    headers: str
    size: int
    attachments: list[Attachment] = field(default_factory=list)
    gmail_labels: list[str] = field(default_factory=list)


# ---------- headers ----------


_SURROGATES = re.compile("[\udc80-\udcff]+")


def _fix_run(m: re.Match) -> str:
    b = m.group().encode("utf-8", "surrogateescape")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1252", "replace")


def _unsurrogate(s: str) -> str:
    """Raw 8-bit header bytes arrive as lone surrogates; decode each run as UTF-8, else cp1252,
    leaving already-decoded text (from RFC 2047 words) alone."""
    return _SURROGATES.sub(_fix_run, s) if s else s


def _decode_words(v: str) -> str:
    try:
        return str(make_header(decode_header(v)))
    except Exception:
        return v


def _raw_value(msg: EmailMessage, name: str) -> str | None:
    """Undecoded header value (RFC 2047 words intact), with 8-bit bytes repaired."""
    for k, v in msg.raw_items():
        if k.lower() == name.lower():
            return _unsurrogate(str(v))
    return None


def _raw_header(msg: EmailMessage, name: str) -> str | None:
    v = _raw_value(msg, name)
    return None if v is None else _unsurrogate(_decode_words(v))


def header(msg: EmailMessage, name: str) -> str:
    """Decoded header value; falls back to manual RFC 2047 decoding when the policy parser chokes."""
    try:
        v = msg[name]
        return "" if v is None else collapse_ws(_unsurrogate(str(v)))
    except Exception:
        return collapse_ws(_raw_header(msg, name) or "")


def _clean_name(name: str, addr: str) -> str:
    name = (name or "").strip().strip("'\"").strip()
    if addr:
        # readpst writes "Name <addr>" <addr>
        name = re.sub(r"\s*<\s*" + re.escape(addr) + r"\s*>\s*$", "", name, flags=re.I).strip().strip("'\"")
        if name.lower() == addr.lower():
            name = ""
    return collapse_ws(name)


def _split_addresses(raw: str) -> list[tuple[str, str]]:
    """Outlook/PST headers often hold display names only, separated by ';' with 'Last, First' names:
    'Natarajan, Priya; Jordan Lee'. Commas only separate addresses when there are addresses.
    `raw` is undecoded, so an encoded name like =?utf-8?q?M=C3=BCller=2C_Hans?= can't be split on its comma."""
    items = []
    parts = raw.split(";") if (";" in raw or "@" not in raw) else [raw]
    for part in parts:
        part = part.strip()
        if not part or part.endswith(":"):  # empty group, e.g. "undisclosed-recipients:;"
            continue
        part = re.sub(r"^[^\s@\"<>:,]+(?:\s[^@\"<>:,]+)*:\s*", "", part) if "@" in part else part  # "Team: a@x"
        if "@" in part:
            items += [(_decode_words(n), a) for n, a in email.utils.getaddresses([part])]
        else:
            items.append((_decode_words(part).strip().strip('"').strip(), ""))
    return items


def addresses(msg: EmailMessage, name: str) -> list[tuple[str, str]]:
    raw = _raw_value(msg, name)
    if raw is None:
        return []
    raw = collapse_ws(raw)
    if "@" in raw and ";" not in raw:
        try:
            items = [(a.display_name, a.addr_spec) for a in msg[name].addresses]
        except Exception:
            items = [(_decode_words(n), a) for n, a in email.utils.getaddresses([raw])]
    else:
        items = _split_addresses(raw)
    out = []
    for disp, addr in items:
        disp, addr = _unsurrogate(disp or ""), _unsurrogate(addr or "")
        addr = addr.strip().strip("<>").strip()
        if "@" not in addr:
            # a bare word parsed as an address is really a display name
            disp, addr = (disp or addr), ""
        else:
            addr = addr.lower()
        disp = _clean_name(disp, addr)
        if (disp or addr) and disp.lower() not in ("undisclosed-recipients", "undisclosed recipients"):
            out.append((disp, addr))
    return out


_MSGID = re.compile(r"<([^<>\s]+)>")


def msgids(value: str) -> list[str]:
    ids = _MSGID.findall(value or "")
    if not ids and value and re.fullmatch(r"[^\s<>]+@[^\s<>]+", value.strip()):
        ids = [value.strip()]  # bare id without brackets; free text like "your message of Monday" is ignored
    return [i.strip().lower() for i in ids]


def parse_date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        d = email.utils.parsedate_to_datetime(value)
    except Exception:
        return None
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    if not (1971 <= d.year <= datetime.now().year + 1):
        return None
    return d.astimezone(UTC)


def parse_from_line(line: str | None) -> datetime | None:
    """mbox separator: 'From sender Wed Mar 11 07:01:46 2026' (local time of the converter, no zone)."""
    if not line:
        return None
    m = re.search(r"(\w{3}) +(\w{3}) +(\d{1,2}) +(\d{1,2}):(\d{2}):(\d{2}) +(\d{4})\s*$", line.strip())
    if not m:
        return None
    try:
        d = datetime.strptime(
            " ".join(m.groups()[1:3]) + f" {m.group(4)}:{m.group(5)}:{m.group(6)} {m.group(7)}", "%b %d %H:%M:%S %Y"
        )
    except ValueError:
        return None
    return d.replace(tzinfo=UTC)


def _received_date(msg: EmailMessage) -> datetime | None:
    for k, v in msg.raw_items():
        if k.lower() == "received" and ";" in str(v):
            d = parse_date(str(v).rsplit(";", 1)[1])
            if d:
                return d
    return None


def thread_index_key(value: str) -> str | None:
    """Outlook Thread-Index: first 22 bytes identify the conversation."""
    if not value:
        return None
    try:
        raw = base64.b64decode(value.strip() + "==", validate=False)
    except Exception:
        return None
    return raw[:22].hex() if len(raw) >= 22 else None


# ---------- bodies ----------


def _decode_text(part: EmailMessage) -> str:
    charset = part.get_content_charset()
    if charset:  # without a declared charset get_content() assumes ASCII and mangles 8-bit text
        try:
            return part.get_content()
        except Exception:
            pass
    data = part.get_payload(decode=True) or b""
    for cs in (charset or "utf-8", "utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(cs)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", "replace")


def _safe_filename(name: str, fallback: str) -> str:
    name = collapse_ws((name or "").replace("\x00", ""))
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    if not name:
        name = fallback
    if len(name) > 150:
        stem, dot, ext = name.rpartition(".")
        name = (stem[:140] + dot + ext[:9]) if dot and len(ext) <= 9 else name[:150]
    return name


_EXT = {
    "text/plain": "txt",
    "text/html": "html",
    "text/calendar": "ics",
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "message/rfc822": "eml",
    "application/ms-tnef": "dat",
}


def _leaves(part: EmailMessage, top: bool = True):
    ctype = part.get_content_type()
    if ctype == "message/rfc822" and not top:
        yield part
        return
    if part.is_multipart():
        try:
            subs = list(part.iter_parts())
        except Exception:
            subs = [p for p in (part.get_payload() or []) if isinstance(p, EmailMessage)]
        for sub in subs:
            yield from _leaves(sub, top=False)
    else:
        yield part


def _rfc822_bytes(part: EmailMessage) -> bytes:
    payload = part.get_payload()
    inner = payload[0] if isinstance(payload, list) and payload else None
    if inner is None:
        return part.get_payload(decode=True) or b""
    try:
        return inner.as_bytes(policy=policy.default.clone(linesep="\r\n"))
    except Exception:
        try:
            return inner.as_string().encode("utf-8", "replace")
        except Exception:
            return b""


def _bodies(msg: EmailMessage) -> tuple[str, str | None, list[Attachment]]:
    texts, htmls, atts = [], [], []
    for i, part in enumerate(_leaves(msg)):
        ctype = part.get_content_type()
        try:
            disp = part.get_content_disposition()
        except Exception:
            disp = None
        try:
            fname = part.get_filename()
        except Exception:
            fname = None
        cid = (part.get("Content-ID") or "").strip().strip("<>") or None

        if ctype == "message/rfc822":
            inner = part.get_payload()[0] if isinstance(part.get_payload(), list) and part.get_payload() else None
            subj = header(inner, "Subject") if inner is not None else ""
            atts.append(
                Attachment(
                    _safe_filename(fname or subj, f"message-{i}")
                    + ("" if (fname or "").lower().endswith(".eml") else ".eml"),
                    "message/rfc822",
                    _rfc822_bytes(part),
                )
            )
            continue
        is_body_text = ctype in ("text/plain", "text/html") and not fname and disp != "attachment"
        if is_body_text:
            (texts if ctype == "text/plain" else htmls).append(_decode_text(part))
            continue
        try:
            data = part.get_payload(decode=True) or b""
        except Exception:
            data = b""
        name = _safe_filename(fname, f"attachment-{i}.{_EXT.get(ctype, ctype.split('/')[-1][:8] or 'bin')}")
        inline = disp == "inline" or (cid is not None and ctype.startswith("image/"))
        atts.append(Attachment(name, ctype, data, inline=inline, cid=cid))

    html = "\n".join(htmls) if htmls else None
    text = tidy_text("\n\n".join(texts))
    if html:
        html_text = html_to_text(html)
        # text/plain stubs such as "view this email in your browser"
        if len(text) < 0.3 * len(html_text):
            text = html_text
    return text, html, atts


def parse_message(raw: bytes, from_line: str | None = None) -> Parsed:
    msg = _PARSER.parsebytes(raw)
    head_end = re.search(rb"\r?\n\r?\n", raw)
    headers = raw[: head_end.start()] if head_end else raw[:20000]

    date = parse_date(header(msg, "Date")) or _received_date(msg) or parse_from_line(from_line)
    frm = addresses(msg, "From") or addresses(msg, "Sender") or [("", "")]
    text, html, atts = _bodies(msg)
    labels_raw = header(msg, "X-Gmail-Labels")
    gmail_labels = [x.strip().strip('"') for x in re.findall(r'"[^"]*"|[^,]+', labels_raw)] if labels_raw else []

    return Parsed(
        message_id=(msgids(header(msg, "Message-ID")) or [None])[0],
        in_reply_to=msgids(header(msg, "In-Reply-To")),
        references=msgids(header(msg, "References")),
        thread_index=thread_index_key(header(msg, "Thread-Index")),
        date=date,
        from_=frm[0],
        to=addresses(msg, "To"),
        cc=addresses(msg, "Cc"),
        bcc=addresses(msg, "Bcc"),
        reply_to=addresses(msg, "Reply-To"),
        subject=header(msg, "Subject"),
        text=text,
        html=html,
        headers=headers.decode("utf-8", "replace"),
        size=len(raw),
        attachments=atts,
        gmail_labels=[x for x in gmail_labels if x],
    )
