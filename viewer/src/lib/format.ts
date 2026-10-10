import type { Addr } from "./types";

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Inbox list: "2:01 PM" today, "Mar 11" this year, "3/11/25" before. */
export function listDate(ts: number | null, now = new Date()): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (sameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

/** Conversation view: "Wed, Mar 11, 2026, 2:01 PM (7 months ago)". */
export function fullDate(ts: number | null, withAgo = true): string {
  if (!ts) return "";
  const d = new Date(ts);
  const s = d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return withAgo ? `${s} (${ago(ts)})` : s;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [u, n] of units) if (Math.abs(s) >= n) return rtf.format(-Math.floor(s / n), u);
  return "just now";
}

export function bytes(n: number | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** "Natarajan, Priya" → "Priya Natarajan"; falls back to the address' local part. */
export function displayName([name, addr]: Addr): string {
  let n = (name || "").trim();
  const m = /^([^,]+),\s*([^,]+)$/.exec(n);
  if (m && !/\s/.test(m[1].trim())) n = `${m[2].trim()} ${m[1].trim()}`;
  if (n) return n;
  if (addr) return addr.includes("@") ? addr : addr;
  return "(unknown)";
}

export function firstName(a: Addr): string {
  const n = displayName(a);
  if (n.includes("@")) return n.split("@")[0];
  return n.split(/\s+/)[0];
}

/** Gmail list senders: one sender → full name; several → first names, at most 3. */
export function senderLine(senders: Addr[]): string {
  if (!senders.length) return "(no sender)";
  if (senders.length === 1) return displayName(senders[0]);
  const names = senders.map(firstName);
  if (names.length <= 3) return names.join(", ");
  return `${names[0]} .. ${names.slice(-2).join(", ")}`;
}

const PALETTE = [
  "#1a73e8",
  "#d93025",
  "#188038",
  "#e37400",
  "#9334e6",
  "#007b83",
  "#c5221f",
  "#b06000",
  "#3949ab",
  "#00897b",
  "#8e24aa",
  "#5f6368",
];

export function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function initial(a: Addr): string {
  const n = displayName(a).replace(/^[^\p{L}\p{N}]+/u, "");
  return (n[0] || "?").toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
