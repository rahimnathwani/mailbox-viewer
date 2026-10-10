from mailbox_viewer.textutil import (
    chunk_words,
    clean_body,
    has_reply_prefix,
    html_to_text,
    normalize_subject,
    snippet,
    split_reply,
    tokenize,
)


def test_tokenize_folds_case_accents_and_splits_cjk():
    assert tokenize("Héllo WORLD, iluminación!") == ["hello", "world", "iluminacion"]
    assert tokenize("公園のベンチ") == ["公", "園", "の", "ベ", "ン", "チ"]
    assert tokenize("dana.whitfield@parks.example.gov") == ["dana", "whitfield", "parks", "example", "gov"]
    assert tokenize("x" * 41) == []


def test_reply_prefixes_and_subject_normalization():
    assert has_reply_prefix("RE: Re: budget")
    assert has_reply_prefix("[EXTERNAL] Fwd: budget")
    assert not has_reply_prefix("Rework of the budget")
    assert normalize_subject("Re: RE: [External] Fw: Tree removal") == "tree removal"
    assert normalize_subject("AW: Antw: Haushalt") == "haushalt"


def test_split_reply_cuts_quoted_history():
    body = "Thanks!\n\nOn Mon, Mar 4, 2024 at 10:12 AM Marco <m@x.com> wrote:\n> old text"
    assert split_reply(body) == ("Thanks!", "On Mon, Mar 4, 2024 at 10:12 AM Marco <m@x.com> wrote:\n> old text")
    outlook = "Sure.\n\n-----Original Message-----\nFrom: A\nSent: B\nSubject: C\n\nold"
    assert split_reply(outlook)[0] == "Sure."


def test_forwards_keep_forwarded_content():
    body = "FYI\n\n---------- Forwarded message ---------\nFrom: X\nDate: Y\nSubject: Z\n\nThe real content"
    assert "The real content" in clean_body(body, "Fwd: Z")
    assert "The real content" in split_reply(body)[0]


def test_clean_body_drops_signature_and_mobile_footer():
    assert clean_body("See you there.\n-- \nDana\nParks Dept") == "See you there."
    assert clean_body("Ok\n\nSent from my iPhone") == "Ok"


def test_html_to_text_keeps_blocks_and_drops_styles():
    html = "<html><head><style>p{color:red}</style></head><body><p>One</p><p>Two<br>Three</p><table><tr><td>a</td><td>b</td></tr></table></body></html>"
    assert html_to_text(html) == "One\nTwo\nThree\na b"


def test_snippet_removes_link_residue():
    s = snippet(
        "View in browser (https://x.example/a?b=1)\nShare (http://f.example/s?u=https%3A%2F%2Fm) <https://t.example> Hello"
    )
    assert s == "View in browser Share Hello"


def test_chunk_words_overlap_and_limit():
    words = " ".join(str(i) for i in range(100))
    chunks = chunk_words(words, 40, 10, 10)
    assert chunks[0].split()[0] == "0" and chunks[1].split()[0] == "30"
    assert chunks[-1].split()[-1] == "99"
    assert len(chunk_words(words, 10, 0, 3)) == 3


def test_inline_answers_are_kept_and_on_wrote_is_limited_to_two_lines():
    inline = "Answers inline:\n> Q1?\nA1\n> Q2?\nA2"
    assert split_reply(inline) == (inline, "")
    body = "Hi Bob,\nOn Monday the crew trimmed the oak.\n\nThanks!\nOn Sun, Mar 3, 2024 at 9:00 AM Bob <b@x.com> wrote:\n> old"
    assert snippet(clean_body(body)) == "Hi Bob, On Monday the crew trimmed the oak. Thanks!"


def test_clean_body_drops_quoted_lines_and_trailing_quotes_before_signatures():
    assert clean_body("> Can you send it?\n> Bob\nSure, attached.") == "Sure, attached."
    assert clean_body("Thanks.\n> old\n> old\n--\nJohn") == "Thanks."
    assert clean_body("Answers inline:\n> Q1?\nA1\n> Q2?\nA2") == "Answers inline:\nA1\nA2"
