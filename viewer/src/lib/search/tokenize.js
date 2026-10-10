// Must stay identical to src/mailbox_viewer/textutil.py tokenize(); tests/test_tokenizer_parity.py compares them.
import config from "../../../../src/mailbox_viewer/search-config.json" with { type: "json" };

export const MAX_TOKEN = config.tokenizer.max_token_length;
export const STOPWORDS = new Set(config.tokenizer.stopwords);

const MARKS = /[\u0300-\u036f]+/gu; // Latin/Greek/Cyrillic accents; kana voicing, Indic vowel signs stay
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CJK_SPLIT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][\p{M}]*|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

/** @param {string} s */
export function normalize(s) {
  return s.normalize("NFKD").replace(MARKS, "").normalize("NFC").toLowerCase();
}

/** @param {string} s @returns {string[]} */
export function tokenize(s) {
  const out = [];
  for (const m of normalize(s).matchAll(TOKEN)) {
    const t = m[0];
    if (CJK.test(t)) {
      for (const p of t.matchAll(CJK_SPLIT)) if (p[0].length <= MAX_TOKEN) out.push(p[0]);
    } else if (t.length <= MAX_TOKEN) out.push(t);
  }
  return out;
}
