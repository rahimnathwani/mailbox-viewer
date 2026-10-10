import { useEffect, useState } from "react";
import type { Dataset } from "../lib/dataset";
import { bytes, plural } from "../lib/format";
import type { AttMeta } from "../lib/types";
import { Icon, IconButton, type IconName } from "./Icon";

const ext = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);

export function kindOf(a: { n: string; t: string }): { icon: IconName; color: string; label: string } {
  const e = ext(a.n);
  if (e === "pdf") return { icon: "picture_as_pdf", color: "#d93025", label: "PDF" };
  if (IMAGE.has(e)) return { icon: "image", color: "#d93025", label: "Image" };
  if (["doc", "docx", "odt", "rtf", "pages"].includes(e))
    return { icon: "description", color: "#1a73e8", label: "Document" };
  if (["xls", "xlsx", "xlsm", "csv", "ods", "numbers"].includes(e))
    return { icon: "table_chart", color: "#188038", label: "Spreadsheet" };
  if (["ppt", "pptx", "odp", "key"].includes(e)) return { icon: "slideshow", color: "#e37400", label: "Presentation" };
  if (e === "eml" || a.t === "message/rfc822") return { icon: "mail", color: "#5f6368", label: "Email" };
  if (a.t.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg", "aac"].includes(e))
    return { icon: "music_note", color: "#9334e6", label: "Audio" };
  if (a.t.startsWith("video/") || ["mp4", "mov", "webm", "m4v"].includes(e))
    return { icon: "movie", color: "#d93025", label: "Video" };
  return { icon: "article", color: "#5f6368", label: e.toUpperCase() || "File" };
}

/** Decided by file extension, which is what the server's Content-Type follows: a file claiming to be a PDF
 * but named .html must not be loaded into a frame. */
export const canPreviewInline = (a: AttMeta) => {
  const e = ext(a.n);
  return e === "pdf" || (IMAGE.has(e) && e !== "svg") || ["txt", "csv", "log", "md"].includes(e);
};

/** Download through fetch so the original file name survives cross-origin hosting. */
export async function download(url: string, name: string) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

export function AttachmentCards({
  atts,
  ds,
  messageId,
  onOpen,
}: {
  atts: AttMeta[];
  ds: Dataset;
  messageId: string;
  onOpen: (i: number) => void;
}) {
  if (!atts.length) return null;
  return (
    <div className="attachments">
      <div className="attachments-head">{atts.length === 1 ? "One attachment" : plural(atts.length, "attachment")}</div>
      <div className="att-cards">
        {atts.map((a, i) => {
          const k = kindOf(a);
          const url = ds.attUrl(a.p);
          const isImg = k.label === "Image";
          return (
            <div key={i} className="att-card" title={a.n} data-message={messageId}>
              <button type="button" className="att-thumb" onClick={() => onOpen(i)} aria-label={`Preview ${a.n}`}>
                {isImg ? (
                  <img src={url} alt="" loading="lazy" />
                ) : (
                  <Icon name={k.icon} size={40} className="att-big-icon" />
                )}
              </button>
              <div className="att-meta">
                <span className="att-badge" style={{ background: k.color }}>
                  <Icon name={k.icon} size={14} />
                </span>
                <span className="att-name">{a.n}</span>
              </div>
              <div className="att-hover">
                <IconButton name="download" label={`Download ${a.n}`} onClick={() => download(url, a.n)} />
              </div>
              <div className="att-size">{bytes(a.s)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Preview({
  atts,
  start,
  ds,
  messageId,
  onClose,
}: {
  atts: AttMeta[];
  start: number;
  ds: Dataset;
  messageId: string;
  onClose: () => void;
}) {
  const [i, setI] = useState(start);
  const a = atts[i];
  const url = ds.attUrl(a.p);
  const k = kindOf(a);
  const [text, setText] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  const media = k.label === "Audio" || k.label === "Video";
  const inline = canPreviewInline(a) && !["txt", "csv", "log", "md"].includes(ext(a.n)) && !asText;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the text view whenever another attachment is shown
  useEffect(() => setAsText(false), [i]);
  useEffect(() => {
    setText(null);
    if (inline || media) return;
    let live = true;
    if (a.x && a.k != null)
      ds.attachmentText(messageId, a.k)
        .then((t) => live && setText(t))
        .catch(() => live && setText(""));
    else setText("");
    return () => {
      live = false;
    };
  }, [a, ds, messageId, inline, media]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" && i < atts.length - 1) setI(i + 1);
      else if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [i, atts.length, onClose]);

  return (
    <div
      className="preview"
      role="dialog"
      aria-modal="true"
      aria-label={a.n}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="preview-bar">
        <IconButton name="arrow_back" label="Close" onClick={onClose} className="on-dark" />
        <span className="att-badge" style={{ background: k.color }}>
          <Icon name={k.icon} size={16} />
        </span>
        <span className="preview-name">{a.n}</span>
        <span className="spacer" />
        {a.x && k.label !== "Image" && canPreviewInline(a) && (
          <IconButton
            name="article"
            label={asText ? "Show original" : "Show extracted text"}
            onClick={() => setAsText(!asText)}
            className="on-dark"
            active={asText}
          />
        )}
        <IconButton name="open_in_new" label="Open in new tab" href={url} className="on-dark" />
        <IconButton name="download" label="Download" onClick={() => download(url, a.n)} className="on-dark" />
      </div>
      <div className="preview-body" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {k.label === "Image" ? (
          <img src={url} alt={a.n} className="preview-img" />
        ) : k.label === "Audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: attachments come without caption tracks
          <audio src={url} controls className="preview-audio" />
        ) : k.label === "Video" ? (
          // biome-ignore lint/a11y/useMediaCaption: attachments come without caption tracks
          <video src={url} controls className="preview-img" />
        ) : inline ? (
          <iframe src={url} title={a.n} className="preview-frame" />
        ) : text === null ? (
          <div className="preview-card">Loading…</div>
        ) : text ? (
          <div className="preview-text">
            <div className="preview-note">Text extracted from the file; formatting is not preserved.</div>
            <pre>{text}</pre>
          </div>
        ) : (
          <div className="preview-card">
            <Icon name={k.icon} size={48} />
            <p>No preview available</p>
            <button type="button" className="btn primary" onClick={() => download(url, a.n)}>
              <Icon name="download" size={18} /> Download
            </button>
          </div>
        )}
      </div>
      {atts.length > 1 && (
        <>
          {i > 0 && (
            <IconButton
              name="chevron_left"
              label="Previous"
              onClick={() => setI(i - 1)}
              className="preview-nav prev on-dark"
              size={28}
            />
          )}
          {i < atts.length - 1 && (
            <IconButton
              name="chevron_right"
              label="Next"
              onClick={() => setI(i + 1)}
              className="preview-nav next on-dark"
              size={28}
            />
          )}
        </>
      )}
    </div>
  );
}
