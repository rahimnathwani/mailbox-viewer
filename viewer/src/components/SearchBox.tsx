import { useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../lib/dataset";
import { query } from "../lib/db";
import { listDate, senderLine } from "../lib/format";
import { groupToString, type Op, parseQuery } from "../lib/search/query";
import type { Semantic } from "../lib/search/semantic";
import { getSettings, recentSearches } from "../lib/store";
import type { Thread } from "../lib/types";
import { Icon, IconButton } from "./Icon";

interface Suggestion {
  icon: "history" | "person" | "search" | "filter_list";
  text: string;
  sub?: string;
  query: string;
}

const OP_HINTS: [string, string][] = [
  ["from:", "sender name or address"],
  ["to:", "recipient"],
  ["subject:", "words in the subject"],
  ["has:attachment", "messages with attachments"],
  ["filename:", "attachment name or type, e.g. filename:pdf"],
  ["after:", "date, e.g. after:2024/01/31"],
  ["before:", "date"],
  ["label:", "folder or label"],
  ['"exact phrase"', "words in this order"],
  ["-word", "exclude a word"],
];

export function SearchBox({
  ds,
  value,
  onSearch,
  onOpenThread,
  semantic,
  inputRef,
}: {
  ds: Dataset;
  value: string;
  onSearch: (q: string) => void;
  onOpenThread: (q: string, threadId: string) => void;
  semantic: Semantic;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [sel, setSel] = useState(-1);
  const wrap = useRef<HTMLFormElement>(null);
  const [hits, setHits] = useState<Thread[]>([]);
  useEffect(() => setText(value), [value]);

  // Gmail-style: conversations whose subject or sender match what you're typing
  useEffect(() => {
    const words = text
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !w.includes(":"));
    if (!focused || !words.length) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      await ds.ready;
      const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await query<{ thread_id: string }>(
        `SELECT thread_id FROM ${ds.table} WHERE ${words.map(() => `lower(subject || ' ' || from_name || ' ' || from_addr) LIKE ? ESCAPE '\\'`).join(" AND ")}
         GROUP BY thread_id ORDER BY max(ts) DESC LIMIT 4`,
        words.map(like),
      ).catch(() => []);
      if (live) setHits(rows.map((r) => ds.byId.get(r.thread_id)).filter((x): x is Thread => !!x));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, focused, ds]);

  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setFocused(false);
        setAdvanced(false);
      }
    };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    const t = text.trim().toLowerCase();
    const out: Suggestion[] = [];
    if (!t) {
      for (const r of recentSearches(ds.slug).slice(0, 5)) out.push({ icon: "history", text: r, query: r });
      if (!out.length)
        for (const [op, hint] of OP_HINTS.slice(0, 6))
          out.push({ icon: "filter_list", text: op, sub: hint, query: "" });
      return out;
    }
    const lastWord = t.split(/\s+/).pop() || "";
    for (const r of recentSearches(ds.slug))
      if (r.toLowerCase().includes(t) && r.toLowerCase() !== t) out.push({ icon: "history", text: r, query: r });
    if (lastWord.length >= 2 && !lastWord.includes(":")) {
      const people = ds.manifest.people
        .filter((p) => `${p.name} ${p.addr}`.toLowerCase().includes(lastWord))
        .slice(0, 5);
      const before = text.trim().split(/\s+/).slice(0, -1).join(" ");
      for (const p of people) {
        const v = p.addr || p.name;
        out.push({
          icon: "person",
          text: p.name || p.addr,
          sub: p.name ? p.addr : "",
          query: `${before} from:${/\s/.test(v) ? `"${v}"` : v}`.trim(),
        });
      }
    }
    if (lastWord.endsWith(":") || /^[a-z_]+$/.test(lastWord)) {
      for (const [op, hint] of OP_HINTS)
        if (op.startsWith(lastWord) && op !== lastWord)
          out.push({ icon: "filter_list", text: op, sub: hint, query: "" });
    }
    return out.slice(0, 8);
  }, [text, ds]);

  const submit = (q: string) => {
    setFocused(false);
    setAdvanced(false);
    inputRef.current?.blur();
    onSearch(q.trim());
  };

  const pick = (s: Suggestion) => {
    if (s.query) {
      setText(s.query);
      submit(s.query);
      return;
    }
    const words = text.trimEnd().split(/\s+/);
    if (words.length && s.text.startsWith(words[words.length - 1]) && words[words.length - 1]) words.pop();
    const next = [...words.filter(Boolean), s.text].join(" ") + (s.text.endsWith(":") ? "" : " ");
    setText(next);
    inputRef.current?.focus();
  };

  const showDrop = focused && !advanced && (suggestions.length > 0 || hits.length > 0);
  return (
    <form
      ref={wrap}
      className={`search${focused || advanced ? " focused" : ""}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit(sel >= 0 && suggestions[sel]?.query ? suggestions[sel].query : text);
      }}
    >
      <IconButton name="search" label="Search" onClick={() => submit(text)} className="search-icon" />
      <input
        ref={inputRef}
        value={text}
        placeholder="Search mail"
        aria-label="Search mail"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setSel(-1);
        }}
        onFocus={() => {
          setFocused(true);
          if (
            getSettings().smart &&
            semantic.available &&
            semantic.state === "idle" &&
            !(navigator as { connection?: { saveData?: boolean } }).connection?.saveData
          ) {
            semantic.load().catch(() => {});
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel(Math.min(sel + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel(Math.max(sel - 1, -1));
          } else if (e.key === "Escape") {
            setFocused(false);
            inputRef.current?.blur();
          } else if (e.key === "Tab" && sel >= 0 && !suggestions[sel].query) {
            e.preventDefault();
            pick(suggestions[sel]);
          }
        }}
      />
      {text && (
        <IconButton
          name="close"
          label="Clear search"
          onClick={() => {
            setText("");
            inputRef.current?.focus();
          }}
        />
      )}
      <IconButton name="tune" label="Show search options" onClick={() => setAdvanced(!advanced)} />
      {showDrop && (
        <div className="search-drop" role="listbox">
          {hits.map((t) => (
            <button
              key={t.thread_id}
              type="button"
              className="sd-thread"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setFocused(false);
                inputRef.current?.blur();
                onOpenThread(text.trim(), t.thread_id);
              }}
            >
              <Icon name="mail" size={18} className="muted" />
              <span className="sd-text">{t.subject || "(no subject)"}</span>
              <span className="sd-sub">
                {senderLine(t.senders)} · {listDate(t.last_ts)}
              </span>
            </button>
          ))}
          {hits.length > 0 && suggestions.length > 0 && <div className="sd-divider" />}
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "sel" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              <Icon name={s.icon} size={18} className="muted" />
              <span className="sd-text">{s.text}</span>
              {s.sub && <span className="sd-sub">{s.sub}</span>}
            </button>
          ))}
          <SmartStatus semantic={semantic} />
        </div>
      )}
      {advanced && (
        <Advanced
          ds={ds}
          initial={text}
          onSearch={(q) => {
            setText(q);
            submit(q);
          }}
          onClose={() => setAdvanced(false)}
        />
      )}
    </form>
  );
}

function SmartStatus({ semantic }: { semantic: Semantic }) {
  const [, force] = useState(0);
  useEffect(() => semantic.subscribe(() => force((x) => x + 1)), [semantic]);
  if (!semantic.available || !getSettings().smart) return null;
  const s = semantic.state;
  return (
    <div className="smart-status">
      <Icon name="stars" size={16} />
      {s === "loading" &&
        (semantic.progress < 100 ? <>Smart search loading… {semantic.progress}%</> : <>Smart search starting…</>)}
      {s === "ready" && <>Smart search on: also finds messages with similar meaning</>}
      {s === "error" && <>Smart search unavailable; using word search</>}
      {s === "idle" && <>Smart search starts when you search</>}
    </div>
  );
}

const WITHIN: [string, string][] = [
  ["1d", "1 day"],
  ["3d", "3 days"],
  ["7d", "1 week"],
  ["14d", "2 weeks"],
  ["1m", "1 month"],
  ["2m", "2 months"],
  ["6m", "6 months"],
  ["1y", "1 year"],
];

function Advanced({
  ds,
  initial,
  onSearch,
  onClose,
}: {
  ds: Dataset;
  initial: string;
  onSearch: (q: string) => void;
  onClose: () => void;
}) {
  const q = parseQuery(initial);
  const get = (op: Op) =>
    q.ops
      .filter((o) => o.op === op && !o.neg)
      .map((o) => o.value)
      .join(" ");
  const [f, setF] = useState({
    from: get("from"),
    to: get("to"),
    subject: get("subject"),
    has: [...q.terms, ...q.phrases.map((p) => `"${p}"`), ...q.groups.filter((g) => !g.neg).map(groupToString)].join(
      " ",
    ),
    not: [...q.notTerms, ...q.notPhrases.map((p) => `"${p}"`)].join(" "),
    within: "",
    date: "",
    label: get("label") || get("in"),
    att: q.ops.some((o) => o.op === "has" && o.value === "attachment"),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  const build = () => {
    const parts: string[] = [];
    if (f.from) parts.push(`from:${quote(f.from)}`);
    if (f.to) parts.push(`to:${quote(f.to)}`);
    if (f.subject) parts.push(/\s/.test(f.subject) ? `subject:(${f.subject})` : `subject:${f.subject}`);
    if (f.has) parts.push(f.has);
    parts.push(...(f.not.match(/"[^"]*"|\S+/g) || []).map((w) => `-${w}`));
    if (f.within && f.date) {
      const d = new Date(`${f.date}T00:00`);
      const span = WITHIN.find((w) => w[0] === f.within)![0];
      const n = +span.slice(0, -1),
        unit = span.slice(-1);
      const a = new Date(d),
        b = new Date(d);
      if (unit === "d") {
        a.setDate(a.getDate() - n);
        b.setDate(b.getDate() + n + 1);
      } else if (unit === "m") {
        a.setMonth(a.getMonth() - n);
        b.setMonth(b.getMonth() + n);
      } else {
        a.setFullYear(a.getFullYear() - n);
        b.setFullYear(b.getFullYear() + n);
      }
      const fmt = (x: Date) => `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}`;
      parts.push(`after:${fmt(a)}`, `before:${fmt(b)}`);
    }
    if (f.label) parts.push(`label:${quote(f.label)}`);
    if (f.att) parts.push("has:attachment");
    return parts.join(" ");
  };
  const labels = [...ds.labels].sort();
  return (
    <div className="advanced" role="dialog" aria-label="Search options">
      <div className="adv-head">
        <IconButton name="close" label="Close" onClick={onClose} />
      </div>
      {(
        [
          ["from", "From"],
          ["to", "To"],
          ["subject", "Subject"],
          ["has", "Has the words"],
          ["not", "Doesn't have"],
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="adv-row">
          <span>{label}</span>
          <input value={f[k] as string} onChange={set(k)} />
        </label>
      ))}
      <div className="adv-row">
        <span>Date within</span>
        <select value={f.within} onChange={set("within")}>
          <option value="">—</option>
          {WITHIN.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input type="date" value={f.date} onChange={set("date")} aria-label="of date" />
      </div>
      <div className="adv-row">
        <span>Search</span>
        <select value={f.label} onChange={set("label")}>
          <option value="">All Mail</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <label className="adv-check">
        <input type="checkbox" checked={f.att} onChange={set("att")} /> Has attachment
      </label>
      <div className="adv-actions">
        <button type="button" className="btn primary" onClick={() => onSearch(build())}>
          Search
        </button>
      </div>
    </div>
  );
}
