// Email body rendering helpers: sanitizing HTML, trimming quoted history, highlighting search words.
import DOMPurify from "dompurify";

const URI_OK = /^(?:(?:https?|mailto|tel|data|mbv-att):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// containers hold the quoted text; headers ("From: … Sent: …") are followed by it
const QUOTE_CONTAINERS = [
  ".gmail_quote",
  "blockquote[type=cite]",
  ".yahoo_quoted",
  "#mail-editor-reference-message-container",
];
const QUOTE_HEADER_BLOCKS = [
  "#divRplyFwdMsg",
  "#x_divRplyFwdMsg",
  "#appendonsend",
  "div.OutlookMessageHeader",
  ".moz-cite-prefix",
];
const QUOTE_SELECTORS = [...QUOTE_CONTAINERS, ...QUOTE_HEADER_BLOCKS];

export interface CleanHtml {
  head: string;
  body: string;
  bodyStyle: string;
  hasRemote: boolean;
  hasQuote: boolean;
}

/** Sanitize, rewrite attachment references to real URLs, wrap quoted history for the "•••" toggle. */
export function cleanHtml(html: string, attBase: string, keepQuotes: boolean, images = false): CleanHtml {
  const doc = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: [
      "script",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "meta",
      "link",
      "base",
      "audio",
      "video",
      "svg",
      "math",
    ],
    FORBID_ATTR: ["srcset", "ping"],
    ADD_ATTR: ["target", "background", "bgcolor", "align", "valign", "cellpadding", "cellspacing"],
    ALLOWED_URI_REGEXP: URI_OK,
  }) as HTMLElement;

  let hasRemote = false;
  for (const el of Array.from(doc.querySelectorAll("[src], [href], [background]"))) {
    for (const attr of ["src", "href", "background"]) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (v.startsWith("mbv-att:")) el.setAttribute(attr, attBase + v.slice(8));
      else if (attr !== "href" && /^https?:/i.test(v)) {
        hasRemote = true;
        if (!images) el.removeAttribute(attr); // tracking pixels never fire; CSP blocks anything left
      }
    }
  }
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  const styles = Array.from(doc.querySelectorAll("style"));
  if (!hasRemote)
    hasRemote =
      styles.some((s) => /url\(\s*['"]?https?:/i.test(s.textContent || "")) || !!doc.querySelector('[style*="url("]');

  const body = doc.querySelector("body") || doc;
  let hasQuote = false;
  if (!keepQuotes) {
    const q = body.querySelector(QUOTE_SELECTORS.join(","));
    if (q && !/^\s*-{5,}\s*Forwarded message/i.test(q.textContent || "")) {
      hasQuote = wrapFrom(q, body, q.matches(QUOTE_CONTAINERS.join(",")));
    } else {
      // Outlook: <hr> or a border-top div followed by From:/Sent: lines
      const marker = Array.from(body.querySelectorAll("div, p, hr")).find((el) => {
        const style = (el.getAttribute("style") || "").toLowerCase();
        if (el.tagName === "HR" || /border-top:\s*solid/.test(style)) {
          const next = (el.nextElementSibling?.textContent || el.textContent || "").slice(0, 200);
          return /^\s*From:/m.test(next) && /(Sent|Date):/.test(next);
        }
        return false;
      });
      if (marker) hasQuote = wrapFrom(marker, body);
    }
  }
  const bodyStyle = [
    body.getAttribute("style") || "",
    body.getAttribute("bgcolor") ? `background-color:${body.getAttribute("bgcolor")}` : "",
  ]
    .filter(Boolean)
    .join(";");
  return {
    head: styles.map((s) => s.outerHTML).join("\n"),
    body: (body as HTMLElement).innerHTML,
    bodyStyle,
    hasRemote,
    hasQuote,
  };
}

/** Move `start` and everything after it (at its level and up to body) into a hidden wrapper. */
function wrapFrom(start: Element, body: Element, container = false): boolean {
  if (start === body || !start.parentElement) return false;
  if (container) {
    // answers written after or between quoted blocks ("inline replies") are new content: don't hide them
    const quotes = QUOTE_CONTAINERS.join(",");
    let after = "";
    for (let el: Element | null = start; el && el !== body; el = el.parentElement) {
      for (let sib = el.nextSibling; sib; sib = sib.nextSibling) {
        if (sib instanceof Element && (sib.matches(quotes) || sib.querySelector(quotes))) continue;
        after += sib.textContent || "";
      }
    }
    if (after.replace(/\s+/g, "").length > 40) return false;
  }
  const wrapper = start.ownerDocument.createElement("div");
  wrapper.className = "mbv-quote";
  let node: Element | null = start;
  // climb while start is the first meaningful child, so the wrapper sits as high as possible
  while (node.parentElement && node.parentElement !== body && node.previousSibling === null) node = node.parentElement;
  const parent = node.parentElement!;
  parent.insertBefore(wrapper, node);
  let cur: ChildNode | null = node;
  while (cur) {
    const next: ChildNode | null = cur.nextSibling;
    wrapper.appendChild(cur);
    cur = next;
  }
  // nothing visible left before the quote? then it isn't trimming anything useful
  const before = (body.textContent || "").replace(wrapper.textContent || "", "").trim();
  if (!before) {
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
    return false;
  }
  return true;
}

export function iframeDoc(c: CleanHtml, opts: { images: boolean; dark: boolean; attOrigin: string }): string {
  const remote = opts.images ? " http: https:" : "";
  const csp = [
    "default-src 'none'",
    `img-src data: blob: ${opts.attOrigin}${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    `media-src ${opts.attOrigin}${remote}`,
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
html,body{margin:0;padding:0}
body{font:14px/1.5 Roboto,Arial,Helvetica,sans-serif;color:#222;overflow-wrap:anywhere;${opts.dark ? "" : ""}}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
.mbv-quote{display:none}
body.mbv-show-quote .mbv-quote{display:block}
mark.mbv-hl{background:#fde293;color:inherit;border-radius:2px}
</style>
${c.head}
</head><body style="${escapeAttr(c.bodyStyle)}">${c.body}</body></html>`;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- plain text ----------

const QUOTE_HEADERS = [
  /^On\b[^\n]{0,300}(?:\n[^\n]{0,200})?\bwrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{8,}\s*\n\s*From:/m,
  /^From:\s.+\n(?:.+\n){0,3}?(?:Sent|Date):\s.+\n(?:.+\n){0,4}?Subject:/m,
];
const FWD = /^(-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/im;

/** [new text, quoted history] — mirrors split_reply() in src/mailbox_viewer/textutil.py */
export function splitReply(text: string): [string, string] {
  let cut = text.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  const q = /^>.*(?:\n>.*)+/m.exec(text);
  if (q && q.index > 0 && q.index < cut) cut = q.index;
  const f = FWD.exec(text);
  if (f && f.index <= cut) return [text, ""];
  return [text.slice(0, cut).trimEnd(), text.slice(cut).trimStart()];
}

const LINK = /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])|\b([\w.+-]+@[\w-]+\.[\w.-]+\w)/g;

/** Escaped HTML for a plain-text body with links and highlighted words. */
export function textToHtml(text: string, highlight: RegExp | null): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    out += hl(escapeHtml(text.slice(last, m.index)), highlight);
    const url = m[1] ? m[1] : `mailto:${m[2]}`;
    out += `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m[0])}</a>`;
    last = m.index! + m[0].length;
  }
  return out + hl(escapeHtml(text.slice(last)), highlight);
}

function hl(html: string, re: RegExp | null): string {
  if (!re) return html;
  return html.replace(re, (w) => `<mark class="mbv-hl">${w}</mark>`);
}

/** Regex matching any of the search words at word starts (accent-insensitive matching is approximate). */
export function highlightRegex(words: string[]): RegExp | null {
  const uniq = [...new Set(words.filter((w) => w.length > 1))].sort((a, b) => b.length - a.length);
  if (!uniq.length) return null;
  const esc = uniq.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${esc.join("|")})[\\p{L}\\p{N}]{0,3}(?![\\p{L}\\p{N}])`, "giu");
}

/** Wrap matches in <mark> inside a live DOM (the HTML email iframe). */
export function highlightDom(root: Node, re: RegExp | null) {
  if (!re) return;
  const doc = root.ownerDocument || (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && /^(script|style|mark)$/i.test(n.parentElement.tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index));
      const mark = doc.createElement("mark");
      mark.className = "mbv-hl";
      mark.textContent = m[0];
      frag.append(mark);
      last = m.index! + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
