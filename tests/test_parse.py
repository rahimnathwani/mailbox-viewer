from email.message import EmailMessage

from mailbox_viewer.parse import msgids, parse_from_line, parse_message


def raw(headers: dict, body="Hello", html=None) -> bytes:
    m = EmailMessage()
    for k, v in headers.items():
        m[k] = v
    m.set_content(body)
    if html:
        m.add_alternative(html, subtype="html")
    return m.as_bytes()


def test_encoded_subject_and_readpst_style_from():
    p = parse_message(
        b'From: "Parks Weekly <news@parksweekly.example.org>" <news@parksweekly.example.org>\r\n'
        b"Subject: =?utf-8?B?UGFya3MgV2Vla2x5IOKAlCBTcHJpbmcgQ2xlYW51cA==?=\r\n"
        b"Date: Wed, 11 Mar 2026 14:01:46 -0800\r\n\r\nbody\r\n"
    )
    assert p.subject == "Parks Weekly — Spring Cleanup"
    assert p.from_ == ("Parks Weekly", "news@parksweekly.example.org")
    assert p.date.isoformat() == "2026-03-11T22:01:46+00:00"


def test_display_name_only_recipients_keep_last_first_names():
    p = parse_message(b"From: a@x.com\r\nTo: Natarajan, Priya; Jordan Lee\r\nCc: Dana\r\n\r\nhi\r\n")
    assert p.to == [("Natarajan, Priya", ""), ("Jordan Lee", "")]
    assert p.cc == [("Dana", "")]


def test_mixed_semicolon_list():
    p = parse_message(b"From: a@x.com\r\nTo: Jane Doe <jane@x.com>; Bob\r\n\r\nhi\r\n")
    assert p.to == [("Jane Doe", "jane@x.com"), ("Bob", "")]


def test_date_falls_back_to_mbox_from_line():
    p = parse_message(b"From: a@x.com\r\nSubject: s\r\n\r\nhi\r\n", "From a@x.com Wed Mar 11 07:01:46 2026")
    assert p.date.year == 2026 and p.date.month == 3 and p.date.day == 11
    assert parse_from_line("From x Sat Jan  4 10:00:00 2020").day == 4


def test_attachments_inline_images_and_forwarded_messages():
    m = EmailMessage()
    m["From"] = "a@x.com"
    m["Subject"] = "with stuff"
    m.set_content("plain")
    m.add_alternative('<p>see <img src="cid:pic1"></p>', subtype="html")
    m.get_payload()[-1].add_related(b"\x89PNG....", "image", "png", cid="<pic1>", filename="pic.png")
    m.add_attachment(b"%PDF-1.4 ...", maintype="application", subtype="pdf", filename="report.pdf")
    inner = EmailMessage()
    inner["Subject"] = "Original"
    inner.set_content("inner body")
    m.add_attachment(inner)
    p = parse_message(m.as_bytes())
    names = {a.name: a for a in p.attachments}
    assert names["pic.png"].inline and names["pic.png"].cid == "pic1"
    assert names["report.pdf"].data.startswith(b"%PDF")
    assert names["Original.eml"].mime == "message/rfc822"
    assert "inner body" not in p.text  # attached emails are not part of the body
    assert p.html and "cid:pic1" in p.html


def test_html_only_message_gets_text():
    p = parse_message(raw({"From": "a@x.com"}, body="", html="<p>Only <b>HTML</b></p>"))
    assert p.text == "Only HTML"


def test_message_ids_and_thread_index():
    p = parse_message(
        b"From: a@x.com\r\nMessage-ID: <ABC@x.com>\r\nIn-Reply-To: <p@x.com>\r\n"
        b"References: <r1@x.com> <p@x.com>\r\nThread-Index: AdXwzQ1kZ5cYcEv7RgmD9bqZqVb2Yg==\r\n\r\nhi\r\n"
    )
    assert p.message_id == "abc@x.com"
    assert p.in_reply_to == ["p@x.com"] and p.references == ["r1@x.com", "p@x.com"]
    assert p.thread_index and len(p.thread_index) == 44


def test_text_without_charset_keeps_accents():
    raw = b"From: a@x.com\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf\xc3\xa9 cr\xc3\xa8me\r\n"
    assert parse_message(raw).text == "Café crème"


def test_encoded_last_first_names_are_not_split():
    raw = b"From: a@x.com\r\nTo: =?utf-8?q?M=C3=BCller=2C_Hans?= <h@x.com>; j@x.com\r\n\r\nhi\r\n"
    assert parse_message(raw).to == [("Müller, Hans", "h@x.com"), ("", "j@x.com")]


def test_empty_groups_and_bare_reply_ids():
    p = parse_message(
        b"From: a@x.com\r\nTo: undisclosed-recipients:;\r\nIn-Reply-To: your message of Monday\r\n\r\nhi\r\n"
    )
    assert p.to == [] and p.in_reply_to == []
    assert msgids("abc@x.com") == ["abc@x.com"]


def test_mixed_encoded_and_raw_bytes_in_one_header():
    raw = b"From: =?utf-8?q?Caf=C3=A9?= M\xfcller <m@x.com>\r\nSubject: s\r\n\r\nhi\r\n"
    assert parse_message(raw).from_ == ("Café Müller", "m@x.com")
