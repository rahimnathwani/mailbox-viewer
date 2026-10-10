import { useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../lib/dataset";
import { avatarColor, displayName, fullDate, initial, listDate } from "../lib/format";
import { highlightRegex } from "../lib/render";
import { isStarred, markRead, toggleStar } from "../lib/store";
import type { Addr, Body, Message, Thread } from "../lib/types";
import { AttachmentCards, Preview } from "./Attachments";
import { HtmlBody, TextBody } from "./Body";
import { Icon, IconButton } from "./Icon";

export function Avatar({ who, size = 40 }: { who: Addr; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: avatarColor(who[1] || who[0]), fontSize: size * 0.45 }}
    >
      {initial(who)}
    </span>
  );
}

const addrList = (l: Addr[]) =>
  l.map((a) => (a[0] && a[1] ? `${displayName(a)} <${a[1]}>` : displayName(a))).join(", ");

function Details({ m, body }: { m: Message; body: Body | undefined }) {
  const replyTo = body?.reply_to || [];
  const rows: [string, string][] = [
    ["from:", addrList([[m.from_name, m.from_addr]])],
    ...(replyTo.length ? [["reply-to:", addrList(replyTo)] as [string, string]] : []),
    ["to:", addrList(m.to) || "(no recipients)"],
    ...(m.cc.length ? [["cc:", addrList(m.cc)] as [string, string]] : []),
    ...(m.bcc.length ? [["bcc:", addrList(m.bcc)] as [string, string]] : []),
    ["date:", fullDate(m.ts, false)],
    ["subject:", m.subject || "(no subject)"],
  ];
  return (
    <table className="details" onClick={(e) => e.stopPropagation()}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="k">{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function recipientsLine(m: Message, owner: string | undefined): string {
  const all = [...m.to, ...m.cc, ...m.bcc];
  if (!all.length) return "to undisclosed recipients";
  const names = all.slice(0, 4).map((a) => (owner && a[1] === owner ? displayName(a).split(/\s+/)[0] : displayName(a)));
  return `to ${names.join(", ")}${all.length > 4 ? `, +${all.length - 4}` : ""}`;
}

function MessageCard({
  m,
  body,
  ds,
  expanded,
  onToggle,
  highlight,
  keepQuotes,
  focused,
  onShowOriginal,
}: {
  m: Message;
  body: Body | undefined;
  ds: Dataset;
  expanded: boolean;
  onToggle: () => void;
  highlight: RegExp | null;
  keepQuotes: boolean;
  focused: boolean;
  onShowOriginal: () => void;
}) {
  const [details, setDetails] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const from: Addr = [m.from_name, m.from_addr];
  const atts = m.atts.filter((a) => !a.h);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  if (!expanded) {
    return (
      <div
        ref={ref}
        className={`msg collapsed${focused ? " focused" : ""}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Avatar who={from} />
        <div className="msg-collapsed-main">
          <span className="msg-from">{displayName(from)}</span>
          <span className="msg-snippet">{body?.snippet ?? ""}</span>
        </div>
        {atts.length > 0 && <Icon name="attach_file" size={16} className="muted" />}
        <span className="msg-date">{listDate(m.ts)}</span>
      </div>
    );
  }
  return (
    <div ref={ref} className={`msg expanded${focused ? " focused" : ""}`} data-doc={m.doc}>
      <div className="msg-head" onClick={onToggle}>
        <Avatar who={from} />
        <div className="msg-head-main">
          <div className="msg-head-line">
            <span className="msg-from">{displayName(from)}</span>
            {m.from_addr && m.from_name && <span className="msg-addr">&lt;{m.from_addr}&gt;</span>}
          </div>
          <button
            type="button"
            className="msg-to"
            onClick={(e) => {
              e.stopPropagation();
              setDetails(!details);
            }}
            aria-expanded={details}
          >
            {recipientsLine(m, ds.manifest.owner?.addr)}
            <Icon name="arrow_drop_down" size={18} />
          </button>
          {details && <Details m={m} body={body} />}
        </div>
        <div className="msg-head-side" onClick={(e) => e.stopPropagation()}>
          {atts.length > 0 && <Icon name="attach_file" size={16} className="muted" />}
          <span className="msg-date" title={fullDate(m.ts, false)}>
            {fullDate(m.ts)}
          </span>
          <div className="menu-wrap">
            <IconButton name="more_vert" label="More" onClick={() => setMenu(!menu)} />
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    onShowOriginal();
                  }}
                >
                  <Icon name="code" size={18} />
                  Show original
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    navigator.clipboard?.writeText(location.href);
                  }}
                >
                  <Icon name="content_copy" size={18} />
                  Copy link to conversation
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    window.print();
                  }}
                >
                  <Icon name="print" size={18} />
                  Print
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="msg-body">
        {!body ? (
          <div className="msg-loading">
            <span className="spinner" />
          </div>
        ) : body.html ? (
          <HtmlBody html={body.html} attBase={ds.base} highlight={highlight} keepQuotes={keepQuotes} />
        ) : (
          <TextBody text={body.text || ""} highlight={highlight} keepQuotes={keepQuotes} />
        )}
        <AttachmentCards atts={atts} ds={ds} messageId={m.id} onOpen={setPreview} />
      </div>
      {preview !== null && (
        <Preview atts={atts} start={preview} ds={ds} messageId={m.id} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function Original({ m, body, onClose }: { m: Message; body: Body | undefined; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-label="Original message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>Original message</h2>
          <IconButton name="close" label="Close" onClick={onClose} />
        </div>
        <table className="orig-table">
          <tbody>
            <tr>
              <td>Message ID</td>
              <td>{body?.message_id ? `<${body.message_id}>` : "(none)"}</td>
            </tr>
            <tr>
              <td>Created at</td>
              <td>{fullDate(m.ts, false)}</td>
            </tr>
            <tr>
              <td>From</td>
              <td>{addrList([[m.from_name, m.from_addr]])}</td>
            </tr>
            <tr>
              <td>To</td>
              <td>{addrList(m.to)}</td>
            </tr>
            <tr>
              <td>Subject</td>
              <td>{m.subject}</td>
            </tr>
          </tbody>
        </table>
        <div className="orig-actions">
          <button
            type="button"
            className="btn"
            onClick={() => navigator.clipboard?.writeText(`${body?.headers || ""}\n\n${body?.text || ""}`)}
          >
            <Icon name="content_copy" size={18} /> Copy to clipboard
          </button>
        </div>
        <pre className="orig-src">{body ? `${body.headers}\n\n${body.text || ""}` : "Loading…"}</pre>
      </div>
    </div>
  );
}

export function ThreadView({
  ds,
  thread,
  highlightWords,
  matchDocs,
  onBack,
  onPrev,
  onNext,
  position,
  total,
}: {
  ds: Dataset;
  thread: Thread;
  highlightWords: string[];
  matchDocs: Set<number>;
  onBack: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  position: number;
  total: number;
}) {
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [bodies, setBodies] = useState<Map<number, Body>>(new Map());
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [showMiddle, setShowMiddle] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [original, setOriginal] = useState<Message | null>(null);
  const [kbd, setKbd] = useState(false);
  const slug = ds.slug;
  const highlight = useMemo(() => highlightRegex(highlightWords), [highlightWords]);
  // search matches already opened, so collapsing one isn't undone when the search re-runs
  const opened = useRef(new Set<number>());

  useEffect(() => {
    let live = true;
    setMsgs(null);
    setBodies(new Map());
    setError("");
    setShowMiddle(false);
    setFocus(-1);
    opened.current = new Set();
    ds.messages(thread.thread_id)
      .then((ms) => {
        if (!live) return;
        setMsgs(ms);
        // Gmail: the latest message open, older ones collapsed (search matches open below)
        setOpen(new Set([ms.length - 1]));
        setFocus(ms.length - 1);
      })
      .catch((e) => live && setError(String(e)));
    ds.bodies(thread.thread_id)
      .then((b) => live && setBodies(b))
      .catch((e) => live && setError(String(e)));
    markRead(slug, [thread]);
    return () => {
      live = false;
    };
  }, [ds, thread, slug]);

  // Open search matches. They can arrive after the messages: reloading a search result's URL
  // opens the conversation straight away and runs the search again in the background.
  useEffect(() => {
    if (!msgs) return;
    const add = msgs.flatMap((m, i) => (matchDocs.has(m.doc) && !opened.current.has(m.doc) ? [i] : []));
    if (!add.length) return;
    for (const i of add) opened.current.add(msgs[i].doc);
    setOpen((o) => new Set([...o, ...add]));
  }, [msgs, matchDocs]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        !msgs ||
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        t.closest("input, textarea, [contenteditable]") ||
        document.querySelector(".dialog, .preview")
      )
        return;
      if (e.key === "Enter" && t.closest("button, a, [role=button], [tabindex]")) return;
      if (e.key === "n" && focus < msgs.length - 1) {
        setKbd(true);
        setFocus(focus + 1);
      } else if (e.key === "p" && focus > 0) {
        setKbd(true);
        setFocus(focus - 1);
      } else if ((e.key === "Enter" || e.key === "o") && focus >= 0) {
        const s = new Set(open);
        if (s.has(focus)) s.delete(focus);
        else s.add(focus);
        setOpen(s);
      } else if (e.key === ";") setOpen(new Set(msgs.map((_, i) => i)));
      else if (e.key === ":") setOpen(new Set([msgs.length - 1]));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [msgs, focus, open]);

  const starred = isStarred(slug, thread);
  const ordered = msgs || [];
  const hideMiddle = !showMiddle && ordered.length > 4;
  const hidden = hideMiddle
    ? ordered.map((_, i) => i).filter((i) => i > 0 && i < ordered.length - 2 && !open.has(i))
    : [];
  const allOpen = ordered.length > 0 && ordered.every((_, i) => open.has(i));
  const subject = thread.subject || "(no subject)";
  const userLabels = thread.labels.filter((l) => !["Sent", "Drafts"].includes(l));

  return (
    <div className="thread-view">
      <div className="toolbar">
        <IconButton name="arrow_back" label="Back to list (u)" onClick={onBack} />
        <IconButton
          name="mark_as_unread"
          label="Mark as unread (shift+u)"
          onClick={() => {
            markRead(slug, [thread], false);
            onBack();
          }}
        />
        <IconButton
          name={starred ? "star-fill" : "star"}
          label={starred ? "Unstar (s)" : "Star (s)"}
          onClick={() => toggleStar(slug, thread)}
          className={starred ? "starred" : ""}
        />
        <span className="spacer" />
        {total > 0 && (
          <span className="pager-text">
            {position.toLocaleString()} of {total.toLocaleString()}
          </span>
        )}
        <IconButton name="chevron_left" label="Newer (k)" onClick={() => onPrev?.()} disabled={!onPrev} />
        <IconButton name="chevron_right" label="Older (j)" onClick={() => onNext?.()} disabled={!onNext} />
      </div>
      <div className="thread-scroll">
        <div className="thread-subject">
          <h1>{subject}</h1>
          {userLabels.map((l) => (
            <a key={l} className="label-chip" href={l === "Inbox" ? "#inbox" : `#label/${encodeURIComponent(l)}`}>
              {l}
            </a>
          ))}
          <span className="spacer" />
          <IconButton
            name={allOpen ? "unfold_less" : "unfold_more"}
            label={allOpen ? "Collapse all" : "Expand all"}
            onClick={() => setOpen(allOpen ? new Set([ordered.length - 1]) : new Set(ordered.map((_, i) => i)))}
          />
          <IconButton
            name="print"
            label="Print all"
            onClick={() => {
              setOpen(new Set(ordered.map((_, i) => i)));
              setTimeout(() => window.print(), 300);
            }}
          />
        </div>
        {error && <div className="error-box">Could not load this conversation: {error}</div>}
        {!msgs && !error && (
          <div className="msg-loading">
            <span className="spinner" />
          </div>
        )}
        {ordered.map((m, i) => {
          if (hidden.includes(i)) {
            if (i === hidden[0]) {
              const n = hidden.length;
              return (
                <button key="middle" type="button" className="older-pill" onClick={() => setShowMiddle(true)}>
                  <span className="older-count">{n}</span> {n === 1 ? "older message" : "older messages"}
                </button>
              );
            }
            return null;
          }
          return (
            <MessageCard
              key={m.doc}
              m={m}
              body={bodies.get(m.doc)}
              ds={ds}
              expanded={open.has(i)}
              focused={kbd && focus === i}
              onToggle={() => {
                const s = new Set(open);
                if (s.has(i)) s.delete(i);
                else s.add(i);
                setOpen(s);
                setFocus(i);
              }}
              highlight={highlight}
              keepQuotes={false}
              onShowOriginal={() => setOriginal(m)}
            />
          );
        })}
      </div>
      {original && <Original m={original} body={bodies.get(original.doc)} onClose={() => setOriginal(null)} />}
    </div>
  );
}
