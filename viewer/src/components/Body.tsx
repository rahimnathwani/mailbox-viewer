import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cleanHtml, highlightDom, iframeDoc, splitReply, textToHtml } from "../lib/render";
import { getSettings, setSettings } from "../lib/store";

function QuoteToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="quote-toggle"
      onClick={onClick}
      title={open ? "Hide expanded content" : "Show trimmed content"}
      aria-label={open ? "Hide expanded content" : "Show trimmed content"}
      aria-expanded={open}
    >
      •••
    </button>
  );
}

export function TextBody({
  text,
  highlight,
  keepQuotes,
}: {
  text: string;
  highlight: RegExp | null;
  keepQuotes: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [fresh, quoted] = useMemo(() => (keepQuotes ? [text, ""] : splitReply(text)), [text, keepQuotes]);
  return (
    <div className="text-body">
      <div dangerouslySetInnerHTML={{ __html: textToHtml(fresh || text, highlight) }} />
      {quoted && fresh && (
        <>
          <QuoteToggle open={open} onClick={() => setOpen(!open)} />
          {open && <div className="quoted" dangerouslySetInnerHTML={{ __html: textToHtml(quoted, highlight) }} />}
        </>
      )}
    </div>
  );
}

export function HtmlBody({
  html,
  attBase,
  highlight,
  keepQuotes,
}: {
  html: string;
  attBase: string;
  highlight: RegExp | null;
  keepQuotes: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [showImages, setShowImages] = useState(getSettings().images);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [height, setHeight] = useState(80);
  const clean = useMemo(
    () => cleanHtml(html, attBase, keepQuotes, showImages),
    [html, attBase, keepQuotes, showImages],
  );
  const attOrigin = useMemo(() => new URL(attBase, location.href).origin, [attBase]);
  const srcDoc = useMemo(
    () => iframeDoc(clean, { images: showImages, dark: false, attOrigin }),
    [clean, showImages, attOrigin],
  );

  const measure = () => {
    const f = ref.current;
    const doc = f?.contentDocument;
    if (!f || !doc?.body) return;
    // fit wide newsletters into narrow panes instead of scrolling sideways
    doc.body.style.zoom = "";
    const avail = f.clientWidth;
    const wide = doc.documentElement.scrollWidth;
    if (wide > avail + 4 && avail > 0) doc.body.style.zoom = String(Math.max(0.4, avail / wide));
    const h = Math.ceil(doc.documentElement.getBoundingClientRect().height || doc.body.scrollHeight);
    setHeight(Math.max(40, h + 4));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach to each new iframe document (srcDoc); measure and quoteOpen are read at load time
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    let ro: ResizeObserver | null = null;
    const onLoad = () => {
      const doc = f.contentDocument;
      if (!doc) return;
      highlightDom(doc.body, highlight);
      doc.body.classList.toggle("mbv-show-quote", quoteOpen);
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(() => measure());
      ro.observe(doc.documentElement);
      for (const img of Array.from(doc.images))
        if (!img.complete) img.addEventListener("load", measure, { once: true });
      setTimeout(measure, 300);
    };
    f.addEventListener("load", onLoad);
    return () => {
      f.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [srcDoc, highlight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only reacts to the quote toggle; measure reads the live iframe
  useLayoutEffect(() => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) {
      doc.body.classList.toggle("mbv-show-quote", quoteOpen);
      measure();
    }
  }, [quoteOpen]);

  return (
    <div className="html-body">
      {clean.hasRemote && !showImages && (
        <div className="images-banner">
          Images are not displayed.{" "}
          <button type="button" className="link" onClick={() => setShowImages(true)}>
            Display images below
          </button>
          {" - "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setSettings({ images: true });
              setShowImages(true);
            }}
          >
            Always display external images
          </button>
        </div>
      )}
      <iframe
        ref={ref}
        title="Message body"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        style={{ height }}
        referrerPolicy="no-referrer"
      />
      {clean.hasQuote && <QuoteToggle open={quoteOpen} onClick={() => setQuoteOpen(!quoteOpen)} />}
    </div>
  );
}
