import { useMemo, useState } from "react";
import type { Dataset } from "../lib/dataset";
import { displayName } from "../lib/format";
import { formatRoute, type Route, type View } from "../lib/route";
import { isStarred, isUnread, useStore } from "../lib/store";
import { Icon, type IconName } from "./Icon";

interface NavItem {
  view: View;
  arg?: string;
  label: string;
  icon: IconName;
  iconOn: IconName;
  count?: number;
  bold?: boolean;
}

const SYSTEM_LABELS = new Set(["Inbox", "Sent", "Drafts", "Spam", "Trash"]);

export function Sidebar({
  ds,
  route,
  collapsed,
  onAbout,
  onNavigate,
}: {
  ds: Dataset;
  route: Route;
  collapsed: boolean;
  onAbout: () => void;
  onNavigate: () => void;
}) {
  const v = useStore();
  const [moreLabels, setMoreLabels] = useState(false);
  const [morePeople, setMorePeople] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: v is the store version: recount when read or starred marks change
  const unread = useMemo(() => {
    const c = new Map<string, number>();
    let starred = 0;
    for (const t of ds.threads) {
      if (isStarred(ds.slug, t)) starred++;
      if (!isUnread(ds.slug, t)) continue;
      for (const l of t.labels) c.set(l, (c.get(l) || 0) + 1);
    }
    return { c, starred };
  }, [ds, v]);

  const items: NavItem[] = [];
  if (ds.hasLabel("Inbox"))
    items.push({
      view: "inbox",
      label: "Inbox",
      icon: "inbox",
      iconOn: "inbox-fill",
      count: unread.c.get("Inbox"),
      bold: true,
    });
  items.push({
    view: "starred",
    label: "Starred",
    icon: "star",
    iconOn: "star-fill",
    count: unread.starred || undefined,
  });
  if (ds.hasLabel("Sent")) items.push({ view: "sent", label: "Sent", icon: "send", iconOn: "send-fill" });
  if (ds.hasLabel("Drafts")) items.push({ view: "drafts", label: "Drafts", icon: "draft", iconOn: "draft-fill" });
  items.push({ view: "all", label: "All Mail", icon: "mail", iconOn: "mail-fill" });
  if (ds.hasLabel("Spam")) items.push({ view: "spam", label: "Spam", icon: "report", iconOn: "report-fill" });
  if (ds.hasLabel("Trash")) items.push({ view: "trash", label: "Trash", icon: "delete", iconOn: "delete-fill" });

  const labels = ds.manifest.labels.map((l) => l.name).filter((l) => !SYSTEM_LABELS.has(l));
  const shownLabels = moreLabels ? labels : labels.slice(0, 8);
  const people = ds.manifest.people;
  const shownPeople = morePeople ? people.slice(0, 50) : people.slice(0, 6);
  const nameCount = new Map<string, number>();
  for (const p of people)
    nameCount.set(displayName([p.name, p.addr]), (nameCount.get(displayName([p.name, p.addr])) || 0) + 1);

  const isActive = (it: NavItem) => route.view === it.view && (it.view !== "label" || route.arg === it.arg);
  const link = (it: NavItem) => (
    <a
      key={it.view + (it.arg || "")}
      href={formatRoute({ view: it.view, arg: it.arg })}
      onClick={onNavigate}
      className={`nav-item${isActive(it) ? " active" : ""}${it.bold && it.count ? " has-unread" : ""}`}
      title={it.label}
    >
      <Icon name={isActive(it) ? it.iconOn : it.icon} size={20} />
      <span className="nav-label">{it.label}</span>
      {!!it.count && <span className="nav-count">{it.count.toLocaleString()}</span>}
    </a>
  );

  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label="Mailbox">
      <button type="button" className="compose" onClick={onAbout} title="About this mailbox">
        <Icon name="info" size={22} />
        <span className="nav-label">About</span>
      </button>
      {items.map(link)}
      {labels.length > 0 && (
        <>
          <div className="nav-section">Labels</div>
          {shownLabels.map((l) => {
            const depth = l.split("/").length - 1;
            const it: NavItem = {
              view: "label",
              arg: l,
              label: l.split("/").pop()!,
              icon: "label",
              iconOn: "label-fill",
              count: unread.c.get(l),
            };
            return (
              <div key={l} style={{ paddingLeft: depth * 12 }}>
                {link(it)}
              </div>
            );
          })}
          {labels.length > 8 && (
            <button type="button" className="nav-item more" onClick={() => setMoreLabels(!moreLabels)}>
              <Icon name={moreLabels ? "keyboard_arrow_up" : "keyboard_arrow_down"} size={20} />
              <span className="nav-label">{moreLabels ? "Less" : "More"}</span>
            </button>
          )}
        </>
      )}
      {people.length > 0 && (
        <>
          <div className="nav-section">People</div>
          {shownPeople.map((p) => {
            const v = p.addr || (/\s/.test(p.name) ? `"${p.name}"` : p.name);
            const query = `{from:${v} to:${v}}`;
            const active = route.view === "search" && route.arg === query;
            return (
              <a
                key={p.addr + p.name}
                className={`nav-item person${active ? " active" : ""}`}
                title={`${p.name} ${p.addr} · ${p.count} messages`.trim()}
                href={formatRoute({ view: "search", arg: query })}
                onClick={onNavigate}
              >
                <Icon name="person" size={20} />
                <span className="nav-label">
                  {displayName([p.name, p.addr])}
                  {p.addr && (nameCount.get(displayName([p.name, p.addr])) || 0) > 1 && (
                    <span className="nav-sub"> {p.addr}</span>
                  )}
                </span>
                <span className="nav-count light">{p.count}</span>
              </a>
            );
          })}
          {people.length > 6 && (
            <button type="button" className="nav-item more" onClick={() => setMorePeople(!morePeople)}>
              <Icon name={morePeople ? "keyboard_arrow_up" : "keyboard_arrow_down"} size={20} />
              <span className="nav-label">{morePeople ? "Less" : "More"}</span>
            </button>
          )}
        </>
      )}
    </nav>
  );
}
