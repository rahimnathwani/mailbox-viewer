"""The browser tokenizes queries with viewer/src/lib/search/tokenize.js; it must match Python's index tokens."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from mailbox_viewer.textutil import tokenize

SAMPLES = [
    "Hello World",
    "Héllo wörld — ÇA VA?",
    "dana.whitfield@parks.example.gov",
    "4.4.19 $48,500 2024-03-04",
    "公園のベンチが壊れています",
    "İstanbul ΣΟΦΊΑ straße",
    "naïve café résumé",
    "Ünïcödé ﬁ ligature ①②",
    "emoji 😀 test",
    "x" * 45 + " short",
    "Привет мир",
    "مرحبا بالعالم",
    "under_score and-dash",
]


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_js_and_python_tokenizers_agree():
    script = (
        "import { tokenize } from './viewer/src/lib/search/tokenize.js';"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(tokenize))));"
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(SAMPLES),
        capture_output=True,
        text=True,
        cwd=Path(__file__).parents[1],
        check=True,
    )
    assert json.loads(out.stdout) == [tokenize(s) for s in SAMPLES]
