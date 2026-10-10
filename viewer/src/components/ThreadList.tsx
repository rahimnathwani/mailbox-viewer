import { useEffect, useRef, useState } from "react";
import type { Dataset } from "../lib/dataset";
import { displayName, listDate, senderLine } from "../lib/format";
import { highlightRegex, textToHtml } from "../lib/render";
import { parseQuery, setOp } from "../lib/search/query";
import { getSettings, isStarred, isUnread, markRead, toggleStar, useStore } from "../lib/store";
import type { Thread } from "../lib/types";
import { kindOf } from "./Attachments";
import { Icon, IconButton } from "./Icon";

export interface ListProps {
  ds: Dataset;
  rows: Thread[];
  /** index in `rows` where the "similar by meaning" section starts, or -1 */
  similarAt: number;
  offset: number;
  total: number;
  pageSize: number;
  cursor: number;
  hideLabel?: string;
  highlightWords: string[];
  loading: boolean;
  empty: React.ReactNode;
  onOpen: (t: Thread) => void;
  onPage: (delta: number) => void;
  onCursor: (i: number) => void;
  onExport?: () => void;
  headerExtra?: React.ReactNode;
}

const SYSTEM = new Set(["Sent", "Drafts", "Spam", "Trash"]);

function Row({
  t,
  ds,
  focused,
  hideLabel,
  hl,
  onOpen,
  onFocus,
}: {
  t: Thread;
  ds: Dataset;
  focused: boolean;
  hideLabel?: string;
  hl: RegExp | null;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const toLine = hideLabel === "Sent" || hideLabel === "Drafts";
  const unread = isUnread(ds.slug, t);
  const starred = isStarred(ds.slug, t);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const labels = t.labels.filter((l) => l !== hideLabel && !SYSTEM.has(l));
  const atts = t.atts;
  return (
    <div
      ref={ref}
      className={`row${unread ? " unread" : ""}${focused ? " focused" : ""}`}
      role="link"
      tabIndex={-1}
      onClick={onOpen}
      onMouseEnter={onFocus}
      data-thread={t.thread_id}
    >
      <button
        type="button"
        className={`star${starred ? " on" : ""}`}
        aria-label={starred ? "Starred" : "Not starred"}
        onClick={(e) => {
          e.stopPropagation();
          toggleStar(ds.slug, t);
        }}
      >
        <Icon name={starred ? "star-fill" : "star"} size={20} />
      </button>
      <div className="row-sender" title={(toLine ? t.recipients : t.senders).map(displayName).join(", ")}>
        <span className="sender-text">{toLine ? `To: ${senderLine(t.recipients)}` : senderLine(t.senders)}</span>
        {t.count > 1 && <span className="row-count">{t.count}</span>}
      </div>
      <div className="row-main">
        <div className="row-line">
          {labels.map((l) => (
            <span key={l} className="label-chip small">
              {l}
            </span>
          ))}
          <span
            className="row-subject"
            dangerouslySetInnerHTML={{ __html: textToHtml(t.subject || "(no subject)", hl) }}
          />
          {t.snippet && (
            <span className="row-snippet">
              <span className="sep"> - </span>
              <span dangerouslySetInnerHTML={{ __html: textToHtml(t.snippet, hl) }} />
            </span>
          )}
        </div>
        {atts.length > 0 && (
          <div className="row-atts">
            {atts.slice(0, 3).map((a, i) => {
              const k = kindOf(a);
              return (
                <a
                  key={i}
                  className="att-chip"
                  href={ds.attUrl(a.p)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={a.n}
                >
                  <span style={{ color: k.color }}>
                    <Icon name={k.icon} size={16} />
                  </span>
                  <span className="att-chip-name">{a.n}</span>
                </a>
              );
            })}
            {t.att_count > 3 && <span className="att-more">+{t.att_count - 3}</span>}
          </div>
        )}
      </div>
      {t.has_att && <Icon name="attach_file" size={16} className="row-clip muted" />}
      <div className="row-date" title={t.last_ts ? new Date(t.last_ts).toLocaleString() : ""}>
        {listDate(t.last_ts)}
      </div>
      <div className="row-hover" onClick={(e) => e.stopPropagation()}>
        <IconButton
          name={unread ? "mark_email_read" : "mark_as_unread"}
          label={unread ? "Mark as read" : "Mark as unread"}
          onClick={() => markRead(ds.slug, [t], unread)}
          size={18}
        />
      </div>
    </div>
  );
}

export function ThreadList(p: ListProps) {
  useStore();
  const density = getSettings().density;
  const hl = highlightRegex(p.highlightWords);
  const [menu, setMenu] = useState(false);
  const first = p.total ? p.offset + 1 : 0;
  const last = Math.min(p.offset + p.pageSize, p.total);
  return (
    <div className={`thread-list density-${density}`}>
      <div className="toolbar">
        <div className="menu-wrap">
          <IconButton name="more_vert" label="More" onClick={() => setMenu(!menu)} />
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button
                type="button"
                onClick={() => {
                  markRead(p.ds.slug, p.rows, true);
                  setMenu(false);
                }}
              >
                <Icon name="mark_email_read" size={18} />
                Mark all on this page as read
              </button>
              <button
                type="button"
                onClick={() => {
                  markRead(p.ds.slug, p.rows, false);
                  setMenu(false);
                }}
              >
                <Icon name="mark_as_unread" size={18} />
                Mark all on this page as unread
              </button>
              {p.onExport && (
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    p.onExport!();
                  }}
                >
                  <Icon name="download" size={18} />
                  Export these conversations (CSV)
                </button>
              )}
            </div>
          )}
        </div>
        {p.headerExtra}
        <span className="spacer" />
        {p.total > 0 && (
          <span className="pager-text">
            {first.toLocaleString()}–{last.toLocaleString()} of {p.total.toLocaleString()}
          </span>
        )}
        <IconButton name="chevron_left" label="Newer" onClick={() => p.onPage(-1)} disabled={p.offset === 0} />
        <IconButton name="chevron_right" label="Older" onClick={() => p.onPage(1)} disabled={last >= p.total} />
      </div>
      {p.loading && <div className="progress-bar" />}
      <div className="rows" role="list">
        {!p.loading && p.rows.length === 0 && <div className="empty">{p.empty}</div>}
        {p.rows.map((t, i) => (
          <div key={t.thread_id} role="listitem">
            {i === p.similarAt && (
              <div className="section-head">
                <Icon name="stars" size={18} /> Similar by meaning
                <span className="section-sub">No exact word match; found by smart search</span>
              </div>
            )}
            {i === 0 && p.similarAt > 0 && <div className="section-head plain">Matching messages</div>}
            <Row
              t={t}
              ds={p.ds}
              focused={p.cursor === i}
              hideLabel={p.hideLabel}
              hl={hl}
              onOpen={() => p.onOpen(t)}
              onFocus={() => p.onCursor(i)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Gmail-style search chips ----------

function Dropdown({
  label,
  active,
  children,
  onClear,
}: {
  label: string;
  active: boolean;
  children: (close: () => void) => React.ReactNode;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);
  return (
    <div className="chip-wrap" ref={ref}>
      <span className={`chip${active ? " active" : ""}`}>
        <button type="button" className="chip-label" onClick={() => setOpen(!open)} aria-expanded={open}>
          {label}
          {!(active && onClear) && <Icon name="arrow_drop_down" size={18} />}
        </button>
        {active && onClear && (
          <button type="button" className="chip-x" aria-label={`Clear ${label}`} onClick={onClear}>
            <Icon name="close" size={16} />
          </button>
        )}
      </span>
      {open && <div className="chip-menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function PeoplePicker({ ds, onPick }: { ds: Dataset; onPick: (v: string) => void }) {
  const [f, setF] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const people = ds.manifest.people
    .filter((x) => `${x.name} ${x.addr}`.toLowerCase().includes(f.toLowerCase()))
    .slice(0, 12);
  return (
    <div className="people-picker">
      <input
        ref={input}
        placeholder="Type a name or email"
        value={f}
        onChange={(e) => setF(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && f.trim() && onPick(f.trim())}
      />
      {people.map((x) => (
        <button key={x.addr + x.name} type="button" onClick={() => onPick(x.addr || x.name)}>
          <span className="pp-name">{x.name || x.addr}</span>
          {x.name && x.addr && <span className="pp-addr">{x.addr}</span>}
          <span className="pp-count">{x.count}</span>
        </button>
      ))}
    </div>
  );
}

export function SearchChips({ ds, q, onQuery }: { ds: Dataset; q: string; onQuery: (q: string) => void }) {
  const parsed = parseQuery(q);
  const val = (op: string) => parsed.ops.find((o) => o.op === op && !o.neg)?.value;
  const from = val("from"),
    to = val("to");
  const hasAtt = parsed.ops.some((o) => o.op === "has" && o.value === "attachment" && !o.neg);
  const unread = parsed.ops.some((o) => o.op === "is" && o.value === "unread" && !o.neg);
  const dateOps = parsed.ops.filter((o) => ["older_than", "newer_than", "before", "after"].includes(o.op));
  const dateLabel = dateOps.length
    ? dateOps
        .map(
          (o) =>
            ({ older_than: "older than ", newer_than: "newer than ", before: "before ", after: "after " })[
              o.op as "before"
            ] + o.value,
        )
        .join(", ")
    : "Any time";
  const clearDates = (s: string) =>
    ["older_than", "newer_than", "before", "after"].reduce((acc, o) => setOp(acc, o as "before", null), s);
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const toggleIs = (name: "has" | "is", value: string, on: boolean) => {
    const keep = parseQuery(q).ops.filter((o) => !(o.op === name && o.value === value));
    let s = setOp(q, name, null);
    for (const o of keep.filter((o) => o.op === name)) s += ` ${o.neg ? "-" : ""}${name}:${o.value}`;
    if (on) s += ` ${name}:${value}`;
    onQuery(s.trim());
  };
  return (
    <div className="search-chips">
      <Dropdown label={from ? `From: ${from}` : "From"} active={!!from} onClear={() => onQuery(setOp(q, "from", null))}>
        {(close) => (
          <PeoplePicker
            ds={ds}
            onPick={(v) => {
              close();
              onQuery(setOp(q, "from", v));
            }}
          />
        )}
      </Dropdown>
      <Dropdown label={dateLabel} active={dateOps.length > 0} onClear={() => onQuery(clearDates(q))}>
        {(close) => (
          <div className="date-menu">
            {[
              ["Older than a week", "older_than", "7d"],
              ["Older than a month", "older_than", "1m"],
              ["Older than 6 months", "older_than", "6m"],
              ["Older than a year", "older_than", "1y"],
              ["Newer than a year", "newer_than", "1y"],
            ].map(([label, op, v]) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  close();
                  onQuery(setOp(clearDates(q), op as "before", v));
                }}
              >
                {label}
              </button>
            ))}
            <div className="date-range">
              <label>
                After <input type="date" value={after} onChange={(e) => setAfter(e.target.value)} />
              </label>
              <label>
                Before <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
              </label>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  close();
                  let s = clearDates(q);
                  if (after) s = setOp(s, "after", after.replace(/-/g, "/"));
                  if (before) s = setOp(s, "before", before.replace(/-/g, "/"));
                  onQuery(s);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </Dropdown>
      <button
        type="button"
        className={`chip${hasAtt ? " active" : ""}`}
        onClick={() => toggleIs("has", "attachment", !hasAtt)}
      >
        {hasAtt && <Icon name="check" size={16} />}Has attachment
      </button>
      <Dropdown label={to ? `To: ${to}` : "To"} active={!!to} onClear={() => onQuery(setOp(q, "to", null))}>
        {(close) => (
          <PeoplePicker
            ds={ds}
            onPick={(v) => {
              close();
              onQuery(setOp(q, "to", v));
            }}
          />
        )}
      </Dropdown>
      <button
        type="button"
        className={`chip${unread ? " active" : ""}`}
        onClick={() => toggleIs("is", "unread", !unread)}
      >
        {unread && <Icon name="check" size={16} />}Is unread
      </button>
    </div>
  );
}
