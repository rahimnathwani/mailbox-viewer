// "Export as CSV": the messages behind a list or search, for spreadsheets and reporting.

import type { Dataset } from "./dataset";
import { query } from "./db";
import { siteUrl } from "./site";
import type { Addr, Thread } from "./types";

const addrs = (json: string) => {
  try {
    return (JSON.parse(json) as Addr[]).map(([n, a]) => (n && a ? `${n} <${a}>` : n || a)).join("; ");
  } catch {
    return "";
  }
};

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@\t\r]/.test(s)
    ? `"${s.replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`
    : s;
};

export async function exportCsv(ds: Dataset, threads: Thread[], name: string): Promise<number> {
  await ds.ready;
  const docs = threads.flatMap((t) => t.docs);
  if (!docs.length) return 0;
  const rows = await query<Record<string, unknown>>(
    `SELECT doc, id, thread_id, ts, from_name, from_addr, to_json, cc_json, subject, labels, att_json
     FROM ${ds.table} WHERE doc IN (${docs.map((d) => Math.trunc(d)).join(",")}) ORDER BY ts`,
  );
  const link = (r: Record<string, unknown>) => `${siteUrl(encodeURIComponent(ds.slug))}#all/${r.thread_id}`;
  const lines = [["date", "from", "to", "cc", "subject", "labels", "attachments", "id", "link"].join(",")];
  for (const r of rows) {
    const atts = (() => {
      try {
        return (JSON.parse(r.att_json as string) as { n: string; h?: 1 }[])
          .filter((a) => !a.h)
          .map((a) => a.n)
          .join("; ");
      } catch {
        return "";
      }
    })();
    lines.push(
      [
        r.ts ? new Date(r.ts as number).toISOString() : "",
        r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr,
        addrs(r.to_json as string),
        addrs(r.cc_json as string),
        r.subject,
        ((r.labels as string[]) || []).join("; "),
        atts,
        r.id,
        link(r),
      ]
        .map(cell)
        .join(","),
    );
  }
  const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "messages"}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return rows.length;
}
