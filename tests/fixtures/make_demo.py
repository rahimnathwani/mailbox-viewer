# /// script
# requires-python = ">=3.12"
# dependencies = ["python-docx>=1.1", "openpyxl>=3.1"]
# ///
"""Generate the fictional demo mailbox in tests/fixtures/demo/ (deterministic, safe to publish).

    uv run tests/fixtures/make_demo.py

Covers: References threading, subject-only threading (PST style), newsletters that must not merge,
HTML with inline cid image and a remote tracking pixel, forwarded message/rfc822, display-name-only
recipients, PDF/DOCX/XLSX/CSV attachments, Sent/Spam/Trash/nested labels, accents and CJK.
"""

import io
import mailbox
import shutil
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from pathlib import Path

OUT = Path(__file__).parent / "demo"
TZ = timezone(timedelta(hours=-8))
ME = ("Dana Whitfield", "dana.whitfield@parks.example.gov")
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000010000000100802000000909168360000001d4944415478da63fccf"
    "c0f09f8106c0c4400a608c6a18d530aa61a40100c0f43f01f8a2e6c90000000049454e44ae426082"
)


def pdf(text_lines: list[str]) -> bytes:
    content = "BT /F1 14 Tf 72 720 Td 18 TL " + " ".join(f"({t}) Tj T*" for t in text_lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def docx(paragraphs: list[str]) -> bytes:
    import docx as d

    doc = d.Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def xlsx(rows: list[list]) -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Bids"
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def addr(p):
    return f'"{p[0]}" <{p[1]}>' if p[0] else p[1]


def msg(
    frm, to, subject, when, body, *, cc=None, html=None, msgid=None, reply_to=None, refs=None, atts=(), raw_to=None
):
    m = EmailMessage()
    m["From"] = addr(frm)
    m["To"] = raw_to if raw_to else ", ".join(addr(t) for t in to)
    if cc:
        m["Cc"] = ", ".join(addr(c) for c in cc)
    m["Subject"] = subject
    m["Date"] = format_datetime(when)
    m["Message-ID"] = msgid or make_msgid(domain="demo.example")
    if reply_to:
        m["In-Reply-To"] = reply_to
        m["References"] = " ".join(refs or [reply_to])
    m.set_content(body)
    if html:
        m.add_alternative(html, subtype="html")
    for name, ctype, data, cid in atts:
        maintype, subtype = ctype.split("/")
        if cid:
            m.get_payload()[-1].add_related(data, maintype, subtype, cid=f"<{cid}>", filename=name)
        else:
            m.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return m


def d(y, mo, day, h=9, mi=0):
    return datetime(y, mo, day, h, mi, tzinfo=TZ)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "Projects").mkdir(parents=True)
    boxes: dict[str, list[EmailMessage]] = {
        "Inbox": [],
        "Sent Items": [],
        "Junk E-mail": [],
        "Deleted Items": [],
        "Projects/Playground": [],
    }

    marco = ("Marco Ruiz", "marco.ruiz@greenbuild.example.com")
    priya = ("Priya Natarajan", "priya.n@parks.example.gov")
    council = ("Councilmember Ortiz", "ortiz@council.example.gov")
    news = ("Parks Weekly", "newsletter@parksweekly.example.org")
    resident = ("Hiroshi Tanaka", "h.tanaka@mail.example.net")

    # A: playground budget, proper References threading, across Inbox / Sent / Projects label
    a1 = make_msgid(domain="demo.example")
    a2 = make_msgid(domain="demo.example")
    a3 = make_msgid(domain="demo.example")
    boxes["Projects/Playground"].append(
        msg(
            marco,
            [ME],
            "Playground renovation budget",
            d(2024, 3, 4, 10, 12),
            "Hi Dana,\n\nAttached is our revised budget for the Lincoln Park playground renovation. The total comes to $48,500, "
            "including the rubber safety surfacing and two accessible swings.\n\nBest,\nMarco",
            msgid=a1,
            atts=[
                (
                    "budget-2024.pdf",
                    "application/pdf",
                    pdf(
                        [
                            "Lincoln Park playground renovation",
                            "Total budget: 48,500 dollars",
                            "Safety surfacing: 21,000 dollars",
                            "Accessible swings (2): 9,800 dollars",
                        ]
                    ),
                    None,
                )
            ],
        )
    )
    boxes["Sent Items"].append(
        msg(
            ME,
            [marco],
            "Re: Playground renovation budget",
            d(2024, 3, 5, 8, 30),
            "Thanks Marco. Can you split out the surfacing cost? The council asked about it.\n\nDana\n\n"
            "On Mon, Mar 4, 2024 at 10:12 AM Marco Ruiz <marco.ruiz@greenbuild.example.com> wrote:\n> Attached is our revised budget",
            cc=[priya],
            msgid=a2,
            reply_to=a1,
        )
    )
    boxes["Inbox"].append(
        msg(
            marco,
            [ME],
            "RE: Playground renovation budget",
            d(2024, 3, 6, 15, 2),
            "Dana, surfacing alone is $21,000. Happy to walk the council through it.\n\nMarco\n\n"
            "-----Original Message-----\nFrom: Dana Whitfield\nSent: Tuesday, March 5, 2024 8:30 AM\nSubject: Re: Playground renovation budget\n\nThanks Marco.",
            msgid=a3,
            reply_to=a2,
            refs=[a1, a2],
        )
    )
    boxes["Inbox"].append(
        msg(
            council,
            [ME],
            "Re: Playground renovation budget",
            d(2024, 3, 7, 9, 45),
            "Dana — thanks for the breakdown. I support moving ahead with the accessible swings.\n\nCM Ortiz",
            reply_to=a3,
            refs=[a1, a2, a3],
        )
    )

    # B: subject-only threading, as in PST exports without reply headers
    boxes["Inbox"].append(
        msg(
            resident,
            [ME],
            "Tree removal request on Elm St",
            d(2023, 10, 2, 7, 55),
            "Hello, the old oak in front of 112 Elm St is leaning over the sidewalk after the storm. Could the city inspect it?\n\nHiroshi Tanaka",
        )
    )
    boxes["Sent Items"].append(
        msg(
            ME,
            [resident],
            "RE: Tree removal request on Elm St",
            d(2023, 10, 3, 11, 20),
            "Mr. Tanaka, an arborist will inspect the oak this Thursday.\n\nDana Whitfield\nParks Department",
        )
    )
    boxes["Inbox"].append(
        msg(
            resident,
            [ME],
            "Re: RE: Tree removal request on Elm St",
            d(2023, 10, 6, 16, 5),
            "Thank you, the crew came by and trimmed it. Much appreciated!",
        )
    )

    # C: newsletters with identical subjects: must stay separate conversations
    for i, when in enumerate([d(2024, 1, 5), d(2024, 1, 12), d(2024, 1, 19)]):
        html = (
            f"<html><head><style>.hd{{color:#2e7d32}}</style></head><body><h1 class='hd'>Parks Weekly #{i + 1}</h1>"
            f"<p>Volunteer cleanup this Saturday at Riverside Park. Bring gloves!</p>"
            f"<img src='https://tracker.parksweekly.example.org/open.gif?id={i}' width='1' height='1'>"
            f"<p><a href='https://parksweekly.example.org/issue/{i + 1}'>Read online</a></p></body></html>"
        )
        boxes["Inbox"].append(
            msg(
                news,
                [ME],
                "Parks Weekly: this week in your parks",
                when,
                f"Parks Weekly #{i + 1}\nVolunteer cleanup this Saturday at Riverside Park.",
                html=html,
            )
        )

    # D: HTML with inline (cid) image and a quoted reply in Outlook style
    html = (
        "<html><body><p>Hi Dana,</p><p>Here is the new <b>park map</b> with the dog run marked:</p>"
        "<p><img src='cid:map001' alt='map'></p><p>Priya</p>"
        "<div id='divRplyFwdMsg'><hr><b>From:</b> Dana Whitfield<br><b>Sent:</b> Friday<br><b>Subject:</b> dog run</div>"
        "<blockquote>Where exactly will the dog run go?</blockquote></body></html>"
    )
    boxes["Inbox"].append(
        msg(
            priya,
            [ME],
            "Dog run location",
            d(2024, 2, 9, 13, 30),
            "Hi Dana, here is the new park map with the dog run marked. Priya",
            html=html,
            atts=[("map.png", "image/png", PNG, "map001")],
        )
    )

    # E: forwarded message as message/rfc822 attachment
    inner = msg(
        council,
        [ME],
        "Budget hearing moved to April 18",
        d(2024, 3, 20, 17, 0),
        "The budget hearing has moved to April 18 at 6pm in council chambers.",
    )
    fwd = msg(
        ME,
        [priya],
        "Fwd: Budget hearing moved to April 18",
        d(2024, 3, 21, 8, 0),
        "FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Councilmember Ortiz\nSubject: Budget hearing moved to April 18",
    )
    fwd.add_attachment(inner)
    boxes["Sent Items"].append(fwd)

    # F: display-name-only recipients, as readpst writes for internal Exchange users
    boxes["Inbox"].append(
        msg(
            priya,
            [],
            "Staff meeting notes",
            d(2024, 4, 2, 16, 40),
            "Notes from today: 1) summer camp registration opens May 1. 2) Pool lifeguard hiring is behind schedule.",
            raw_to="Whitfield, Dana; Jordan Lee; Natarajan, Priya",
        )
    )

    # G: bids spreadsheet and contract document
    boxes["Inbox"].append(
        msg(
            marco,
            [ME],
            "Bids for pool resurfacing",
            d(2024, 4, 15, 9, 10),
            "Dana, attached are the three bids we received and the draft contract.",
            atts=[
                (
                    "pool-bids.xlsx",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    xlsx(
                        [
                            ["Vendor", "Amount", "Weeks"],
                            ["AquaSeal", 61200, 5],
                            ["BlueLine Pools", 58950, 7],
                            ["Coastal Concrete", 66400, 4],
                        ]
                    ),
                    None,
                ),
                (
                    "contract-draft.docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    docx(
                        [
                            "Pool resurfacing contract (draft)",
                            "The contractor shall complete resurfacing within seven weeks.",
                            "Liquidated damages: 500 dollars per day.",
                        ]
                    ),
                    None,
                ),
                ("schedule.csv", "text/csv", b"week,task\n1,drain pool\n2,remove old plaster\n3,resurface\n", None),
            ],
        )
    )

    # H: accents and CJK
    boxes["Inbox"].append(
        msg(
            ("José Álvarez", "jalvarez@vecinos.example.org"),
            [ME],
            "Solicitud: iluminación del parque",
            d(2023, 11, 14, 19, 0),
            "Buenas noches, los vecinos pedimos más iluminación en el sendero del parque Peñasco. Gracias.",
        )
    )
    boxes["Inbox"].append(
        msg(
            resident,
            [ME],
            "公園のベンチについて",
            d(2023, 12, 1, 10, 0),
            "公園のベンチが壊れています。修理をお願いします。(The bench in the park is broken.)",
        )
    )

    # I: spam and trash
    boxes["Junk E-mail"].append(
        msg(
            ("Prize Center", "win@prizes.example.biz"),
            [ME],
            "You have WON a free cruise!!!",
            d(2024, 2, 1),
            "Click here to claim your free cruise. Limited time offer.",
        )
    )
    boxes["Deleted Items"].append(
        msg(priya, [ME], "Lunch order", d(2024, 1, 30, 11, 0), "Sandwiches for the volunteer lunch are ordered.")
    )

    # J: duplicate: the same message filed in two folders is merged into one with two labels
    dup = msg(
        council,
        [ME],
        "Thank you for the park tour",
        d(2024, 5, 3, 14, 0),
        "Dana, thank you for yesterday's tour of the renovated playground. Residents love the new swings.",
    )
    boxes["Inbox"].append(dup)
    boxes["Projects/Playground"].append(dup)

    for name, msgs in boxes.items():
        path = OUT / f"{name}.mbox"
        path.parent.mkdir(parents=True, exist_ok=True)
        mb = mailbox.mbox(path, create=True)
        for m in msgs:
            mb.add(m)
        mb.flush()
        mb.close()
        print(f"{path.relative_to(OUT.parent)}: {len(msgs)} messages")


if __name__ == "__main__":
    main()
