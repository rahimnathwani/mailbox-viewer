// Gmail-style hash routes inside /<slug>: #inbox, #starred, #sent, #all, #label/Name, #search/query,
// optionally followed by /p2 (page) and /<threadId>.
import { useEffect, useState } from "react";

export type View = "inbox" | "starred" | "sent" | "drafts" | "all" | "spam" | "trash" | "label" | "search";
export interface Route {
  view: View;
  arg: string;
  page: number;
  thread: string | null;
}

const VIEWS = new Set<View>(["inbox", "starred", "sent", "drafts", "all", "spam", "trash", "label", "search"]);

export function parseHash(hash: string, fallback: View): Route {
  const parts = hash.replace(/^#/, "").split("/").filter(Boolean);
  let view = (parts.shift() || fallback) as View;
  if (!VIEWS.has(view)) view = fallback;
  let arg = "";
  if (view === "label" || view === "search") arg = decodeURIComponent(parts.shift() || "");
  let page = 1;
  let thread: string | null = null;
  for (const p of parts) {
    const m = /^p(\d+)$/.exec(p);
    if (m) page = Math.max(1, +m[1]);
    else if (/^[0-9a-f]{16}$/.test(p)) thread = p;
  }
  return { view, arg, page, thread };
}

export function formatRoute(r: Partial<Route> & { view: View }): string {
  let h = `#${r.view}`;
  if ((r.view === "label" || r.view === "search") && r.arg) h += `/${encodeURIComponent(r.arg)}`;
  if (r.page && r.page > 1) h += `/p${r.page}`;
  if (r.thread) h += `/${r.thread}`;
  return h;
}

export function go(r: Partial<Route> & { view: View }, replace = false) {
  const h = formatRoute(r);
  if (replace) history.replaceState(null, "", location.pathname + location.search + h);
  else if (location.hash !== h) location.hash = h;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useHash(): string {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const on = () => setH(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}
