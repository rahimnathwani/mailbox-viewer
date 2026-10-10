// Per-viewer state in localStorage: read/starred per mailbox, display settings, recent searches.
// Everything degrades to in-memory when storage is unavailable (private mode, blocked).
import { useSyncExternalStore } from "react";
import type { Thread } from "./types";

export interface Settings {
  density: "default" | "comfortable" | "compact";
  theme: "system" | "light" | "dark";
  smart: boolean;
  images: boolean;
  pageSize: number;
}

const DEFAULTS: Settings = { density: "default", theme: "system", smart: true, images: false, pageSize: 50 };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

let settings: Settings = load("mbv:settings", DEFAULTS);

export function getSettings(): Settings {
  return settings;
}

export function setSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  save("mbv:settings", settings);
  emit();
}

interface MailboxState {
  read: Record<string, number>;
  starred: Record<string, 1>;
  recent: string[];
}
const boxes = new Map<string, MailboxState>();

function box(slug: string): MailboxState {
  let b = boxes.get(slug);
  if (!b) {
    b = load<MailboxState>(`mbv:box:${slug}`, { read: {}, starred: {}, recent: [] });
    boxes.set(slug, b);
  }
  return b;
}

function update(slug: string, fn: (b: MailboxState) => void) {
  const b = box(slug);
  fn(b);
  save(`mbv:box:${slug}`, b);
  emit();
}

/** A thread is read when the number of messages seen equals its current count (new messages make it unread again). */
export const isUnread = (slug: string, t: Thread) => box(slug).read[t.thread_id] !== t.count;
export const isStarred = (slug: string, t: Thread) => !!box(slug).starred[t.thread_id];

export function markRead(slug: string, threads: Thread[], read = true) {
  const b0 = box(slug);
  if (threads.every((t) => (read ? b0.read[t.thread_id] === t.count : !(t.thread_id in b0.read)))) return;
  update(slug, (b) => {
    for (const t of threads) {
      if (read) b.read[t.thread_id] = t.count;
      else delete b.read[t.thread_id];
    }
  });
}

export function toggleStar(slug: string, t: Thread) {
  update(slug, (b) => {
    if (b.starred[t.thread_id]) delete b.starred[t.thread_id];
    else b.starred[t.thread_id] = 1;
  });
}

export function recentSearches(slug: string): string[] {
  return box(slug).recent;
}

export function addRecent(slug: string, q: string) {
  const s = q.trim();
  if (!s) return;
  update(slug, (b) => {
    b.recent = [s, ...b.recent.filter((x) => x !== s)].slice(0, 8);
  });
}

/** Re-render when any stored state changes. */
export function useStore(): number {
  return useSyncExternalStore(subscribe, () => version);
}
