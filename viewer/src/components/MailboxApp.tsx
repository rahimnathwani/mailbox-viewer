import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dataset, listDatasets } from "../lib/dataset";
import { query } from "../lib/db";
import { exportCsv } from "../lib/export";
import { go, parseHash, type Route, useHash } from "../lib/route";
import { type SearchResult, search } from "../lib/search/engine";
import { hasFreeText, parseQuery } from "../lib/search/query";
import { Semantic } from "../lib/search/semantic";
import { mailboxPath, site } from "../lib/site";
import { addRecent, getSettings, isStarred, isUnread, markRead, toggleStar, useStore } from "../lib/store";
import type { DatasetEntry, Thread } from "../lib/types";
import { AboutDialog, HelpDialog, SettingsDialog } from "./Dialogs";
import { SetupHelp } from "./Home";
import { Icon, IconButton } from "./Icon";
import { SearchBox } from "./SearchBox";
import { Sidebar } from "./Sidebar";
import { SearchChips, ThreadList } from "./ThreadList";
import { ThreadView } from "./ThreadView";

export function MailboxApp({ slug }: { slug: string }) {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [step, setStep] = useState("Loading");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Dataset.open(slug, (s) => live && setStep(s))
      .then((d) => live && setDs(d))
      .catch((e) => live && setError(String(e.message || e)));
    return () => {
      live = false;
    };
  }, [slug]);
  if (error) return <SetupHelp error={error} />;
  if (!ds) {
    return (
      <div className="splash">
        <img src={site("favicon.svg")} alt="" width={56} height={56} />
        <div className="splash-bar">
          <span />
        </div>
        <div className="splash-step">{step}…</div>
      </div>
    );
  }
  return <Mailbox ds={ds} />;
}

const EMPTY: SearchResult = { threads: [], similar: [], docs: new Set(), highlight: [], semantic: "unused" };
const VIEW_LABEL: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  spam: "Spam",
  trash: "Trash",
};
const VIEW_TITLE: Record<string, string> = {
  inbox: "Inbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  all: "All Mail",
  spam: "Spam",
  trash: "Trash",
};

function viewThreads(ds: Dataset, r: Route): Thread[] {
  const hidden = (t: Thread) => t.labels.length > 0 && t.labels.every((l) => l === "Spam" || l === "Trash");
  switch (r.view) {
    case "all":
      return ds.threads.filter((t) => !hidden(t));
    case "starred":
      return ds.threads.filter((t) => isStarred(ds.slug, t));
    case "label":
      return ds.threads.filter((t) => t.labels.includes(r.arg));
    default: {
      const l = VIEW_LABEL[r.view];
      return l ? ds.threads.filter((t) => t.labels.includes(l)) : ds.threads;
    }
  }
}

function Mailbox({ ds }: { ds: Dataset }) {
  const storeVersion = useStore();
  // ?debug exposes the dataset and SQL for poking at it from the console
  useEffect(() => {
    if (new URLSearchParams(location.search).has("debug"))
      Object.assign(window, { __mbv: { ds, query, search, parseQuery } });
  }, [ds]);
  const settings = getSettings();
  const semantic = useMemo(() => new Semantic(ds), [ds]);
  const [, setSemVer] = useState(0);
  useEffect(() => semantic.subscribe(() => setSemVer((v) => v + 1)), [semantic]);
  useEffect(() => () => semantic.dispose(), [semantic]);

  const defaultView = ds.hasLabel("Inbox") ? "inbox" : "all";
  const hash = useHash();
  const route = parseHash(hash, defaultView);
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [result, setResult] = useState<SearchResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [cursor, setCursor] = useState(0);
  const [kbd, setKbd] = useState(false);
  const [dialog, setDialog] = useState<"help" | "settings" | "about" | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const searchRef = useRef<HTMLInputElement>(null);

  // theme
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  // list for the current view or search
  const starKey = route.view === "starred" || /is:(starred|unread|read)/.test(route.arg) ? storeVersion : 0;
  const semActive = settings.smart && semantic.available;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on the route, sort, smart-search state and (for is: queries) stored marks; not on every render
  useEffect(() => {
    let live = true;
    setSearchError("");
    if (route.view === "search") {
      const q = parseQuery(route.arg);
      if (semActive && semantic.state === "idle" && hasFreeText(q)) semantic.load().catch(() => {});
      setLoading(true);
      search(ds, q, {
        semantic: semActive ? semantic : null,
        sort,
        state: { starred: (t) => isStarred(ds.slug, t), unread: (t) => isUnread(ds.slug, t) },
      })
        .then((r) => live && setResult(r))
        .catch((e) => {
          if (live) {
            setResult(EMPTY);
            setSearchError(String(e.message || e));
          }
        })
        .finally(() => live && setLoading(false));
    } else {
      setLoading(false);
      setResult({ ...EMPTY, threads: viewThreads(ds, route) });
    }
    return () => {
      live = false;
    };
  }, [ds, route.view, route.arg, sort, semantic.state, semActive, starKey]);

  const rows = useMemo(() => [...result.threads, ...result.similar], [result]);
  const pageSize = settings.pageSize;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(route.page, pages);
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);
  const boundary = result.similar.length ? result.threads.length - offset : null;
  const similarAt = boundary === null ? -1 : boundary < 0 ? 0 : boundary < pageRows.length ? boundary : -1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the keyboard cursor restarts on every new list or page
  useEffect(() => setCursor(0), [route.view, route.arg, page]);

  const open = useCallback((t: Thread) => go({ ...route, page, thread: t.thread_id }), [route, page]);
  const back = useCallback(() => go({ ...route, thread: null }), [route]);
  const current = route.thread ? (ds.byId.get(route.thread) ?? null) : null;
  const pos = current ? rows.indexOf(current) : -1;
  const openAt = (i: number) => {
    const t = rows[i];
    if (!t) return;
    go({ ...route, page: Math.floor(i / pageSize) + 1, thread: t.thread_id });
  };

  // document title, Gmail style: "Inbox (3) - Mailbox title"
  // biome-ignore lint/correctness/useExhaustiveDependencies: storeVersion makes the unread count in the title follow read marks
  useEffect(() => {
    const unread = route.view === "inbox" ? rows.filter((t) => isUnread(ds.slug, t)).length : 0;
    const where =
      route.view === "search" ? `Search results` : route.view === "label" ? route.arg : VIEW_TITLE[route.view];
    document.title = `${current ? current.subject || "(no subject)" : `${where}${unread ? ` (${unread})` : ""}`} - ${ds.manifest.title}`;
  }, [route, rows, current, ds, storeVersion]);

  // keyboard shortcuts
  const gPending = useRef(0);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        t.closest("input, textarea, select, [contenteditable]") ||
        document.querySelector(".dialog-backdrop, .preview")
      ) {
        return;
      }
      const k = e.key;
      if (k === "Enter" && t.closest("button, a, [role=button], [tabindex]")) return; // the focused control's own Enter
      if (Date.now() - gPending.current < 1500) {
        gPending.current = 0;
        const v = ({ i: "inbox", s: "starred", t: "sent", a: "all", d: "drafts" } as const)[k as "i"];
        if (v) {
          e.preventDefault();
          go({ view: v });
        }
        return;
      }
      if (k === "g") {
        gPending.current = Date.now();
        return;
      }
      if (k === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (k === "?") {
        setDialog("help");
        return;
      }
      if (current) {
        if (k === "u" || k === "Escape") back();
        else if (k === "j" && pos >= 0 && pos < rows.length - 1) openAt(pos + 1);
        else if (k === "k" && pos > 0) openAt(pos - 1);
        else if (k === "s") toggleStar(ds.slug, current);
        else if (k === "U") {
          markRead(ds.slug, [current], false);
          back();
        } else return;
      } else {
        const t2 = pageRows[cursor];
        if (k === "j") {
          setKbd(true);
          setCursor(kbd ? Math.min(cursor + 1, pageRows.length - 1) : cursor);
        } else if (k === "k") {
          setKbd(true);
          setCursor(Math.max(cursor - 1, 0));
        } else if ((k === "o" || k === "Enter") && t2) open(t2);
        else if (k === "s" && t2) toggleStar(ds.slug, t2);
        else if (k === "I" && t2) markRead(ds.slug, [t2], true);
        else if (k === "U" && t2) markRead(ds.slug, [t2], false);
        else if (k === "Escape" && route.view === "search") go({ view: defaultView });
        else return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const onSearch = (q: string) => {
    if (!q) {
      go({ view: defaultView });
      return;
    }
    addRecent(ds.slug, q);
    go({ view: "search", arg: q });
  };

  const listTitle = route.view === "label" ? route.arg : route.view === "search" ? null : VIEW_TITLE[route.view];
  const empty =
    route.view === "search" ? (
      searchError ? (
        <span className="error-box">Search failed: {searchError}</span>
      ) : (
        <>
          <div className="empty-title">No messages matched your search.</div>
          <div>Try using search options such as sender, date, or attachments.</div>
        </>
      )
    ) : route.view === "starred" ? (
      <>
        <div className="empty-title">No starred messages.</div>
        <div>
          Stars let you give messages a special status to make them easier to find. To star a message, click on the star
          outline beside it.
        </div>
      </>
    ) : (
      <div className="empty-title">No conversations in {listTitle}.</div>
    );

  const semStatus =
    route.view === "search" && hasFreeText(parseQuery(route.arg)) && semActive ? (
      <span
        className={`smart-chip ${semantic.state}`}
        title="Smart search finds messages with similar meaning, even without the exact words"
      >
        <Icon name="stars" size={16} />
        {semantic.state === "loading"
          ? semantic.progress < 100
            ? `Smart search ${semantic.progress}%`
            : "Smart search starting"
          : semantic.state === "ready"
            ? "Smart search"
            : semantic.state === "error"
              ? "Word search only"
              : "Smart search"}
      </span>
    ) : null;

  const headerExtra =
    route.view === "search" ? (
      <>
        <select
          className="sort-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as "relevance" | "date")}
          aria-label="Sort results"
        >
          <option value="relevance">Most relevant</option>
          <option value="date">Most recent</option>
        </select>
        {semStatus}
      </>
    ) : listTitle ? (
      <span className="list-title">{listTitle}</span>
    ) : null;

  return (
    <div className={`app${drawer ? " drawer-open" : ""}`}>
      <header className="topbar">
        <IconButton
          name="menu"
          label="Main menu"
          onClick={() => {
            if (window.innerWidth < 900) setDrawer(!drawer);
            else setSidebarCollapsed(!sidebarCollapsed);
          }}
        />
        <a className="brand" href={`#${defaultView}`} title={`${ds.manifest.title} (${ds.slug})`}>
          <img src={site("favicon.svg")} alt="" width={32} height={32} />
          <span className="brand-text">{ds.manifest.title}</span>
        </a>
        <SearchBox
          ds={ds}
          value={route.view === "search" ? route.arg : ""}
          onSearch={onSearch}
          semantic={semantic}
          inputRef={searchRef}
          onOpenThread={(q, id) => {
            addRecent(ds.slug, q);
            go({ view: "search", arg: q, thread: id });
          }}
        />
        <div className="top-actions">
          <IconButton name="help" label="Keyboard shortcuts and search help" onClick={() => setDialog("help")} />
          <IconButton name="settings" label="Settings" onClick={() => setDialog("settings")} />
          <AccountSwitcher ds={ds} />
        </div>
      </header>
      <div className="body">
        <Sidebar
          ds={ds}
          route={route}
          collapsed={sidebarCollapsed}
          onAbout={() => {
            setDrawer(false);
            setDialog("about");
          }}
          onNavigate={() => setDrawer(false)}
        />
        {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
        <main className="main">
          {route.view === "search" && !current && <SearchChips ds={ds} q={route.arg} onQuery={onSearch} />}
          {current ? (
            <ThreadView
              ds={ds}
              thread={current}
              highlightWords={result.highlight}
              matchDocs={result.docs}
              onBack={back}
              onPrev={pos > 0 ? () => openAt(pos - 1) : null}
              onNext={pos >= 0 && pos < rows.length - 1 ? () => openAt(pos + 1) : null}
              position={pos + 1}
              total={pos >= 0 ? rows.length : 0}
            />
          ) : (
            <ThreadList
              ds={ds}
              rows={pageRows}
              similarAt={similarAt}
              offset={offset}
              total={rows.length}
              pageSize={pageSize}
              cursor={kbd ? cursor : -1}
              hideLabel={route.view === "label" ? route.arg : VIEW_LABEL[route.view]}
              highlightWords={result.highlight}
              loading={loading}
              empty={empty}
              onOpen={open}
              onCursor={setCursor}
              headerExtra={headerExtra}
              onExport={() =>
                exportCsv(
                  ds,
                  result.threads,
                  `${ds.slug}-${route.view === "search" ? route.arg : listTitle || route.view}`,
                )
                  .then((n) => setToast(`Exported ${n.toLocaleString()} messages`))
                  .catch((e) => setToast(`Export failed: ${e.message || e}`))
              }
              onPage={(d) => go({ ...route, page: Math.min(pages, Math.max(1, page + d)), thread: null })}
            />
          )}
        </main>
      </div>
      {toast && (
        <div className="snackbar" role="status">
          {toast}
        </div>
      )}
      {dialog === "help" && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} smartAvailable={semantic.available} />}
      {dialog === "about" && <AboutDialog ds={ds} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AccountSwitcher({ ds }: { ds: Dataset }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<DatasetEntry[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (!list)
      listDatasets()
        .then(setList)
        .catch(() => setList([]));
    const on = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open, list]);
  const title = ds.manifest.title;
  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="account-btn"
        onClick={() => setOpen(!open)}
        title={`${title}\n${ds.manifest.counts.messages.toLocaleString()} messages`}
        aria-label="Switch mailbox"
      >
        {(title[0] || "?").toUpperCase()}
      </button>
      {open && (
        <div className="account-menu">
          <div className="account-current">
            <span className="account-big">{(title[0] || "?").toUpperCase()}</span>
            <div className="account-name">{title}</div>
            <div className="account-addr">
              {ds.slug}
              {ds.manifest.owner?.addr ? ` · ${ds.manifest.owner.addr}` : ""} ·{" "}
              {ds.manifest.counts.messages.toLocaleString()} messages
            </div>
          </div>
          {list
            ?.filter((d) => d.slug !== ds.slug)
            .map((d) => (
              <a key={d.slug} className="account-item" href={mailboxPath(d.slug)}>
                <span className="account-small">{(d.title[0] || "?").toUpperCase()}</span>
                <span>
                  <b>{d.title}</b>
                  <small>
                    {d.slug} · {d.messages.toLocaleString()} messages
                  </small>
                </span>
              </a>
            ))}
          <a className="account-item all" href={site()}>
            <Icon name="group" size={20} /> All mailboxes
          </a>
        </div>
      )}
    </div>
  );
}
