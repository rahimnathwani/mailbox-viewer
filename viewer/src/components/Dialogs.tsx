import { useEffect } from "react";
import type { Dataset } from "../lib/dataset";
import { fullDate } from "../lib/format";
import { getSettings, type Settings, setSettings, useStore } from "../lib/store";
import { Icon, IconButton } from "./Icon";

export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className={`dialog${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <IconButton name="close" label="Close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["j / k", "Older / newer conversation"],
  ["o or Enter", "Open conversation; expand or collapse a message"],
  ["u", "Back to the conversation list"],
  ["n / p", "Next / previous message in a conversation"],
  ["; / :", "Expand / collapse all messages"],
  ["s", "Star or unstar"],
  ["Shift + i / Shift + u", "Mark as read / unread"],
  ["/", "Search"],
  ["g then i / s / t / a", "Go to Inbox / Starred / Sent / All Mail"],
  ["?", "Show keyboard shortcuts"],
  ["Esc", "Close dialog or search"],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Search operators</h3>
      <table className="shortcuts">
        <tbody>
          {[
            ["from:amy", "Sender"],
            ["to:david", "Recipient (to, cc or bcc)"],
            ["subject:dinner", "Words in the subject"],
            ['"exact phrase"', "Words in this order"],
            ["-word", "Leave out messages with this word"],
            ["has:attachment", "Has any attachment (also has:pdf, has:spreadsheet, has:image)"],
            ["filename:report.pdf", "Attachment name or type"],
            ["after:2024/01/31 before:2024/03/01", "Date range"],
            ["older_than:1y  newer_than:2m", "Relative dates (d, m, y)"],
            ["label:work  in:sent", "Folder or label"],
            ["is:starred  is:unread", "Your stars and read state"],
            ["larger:5M", "Message size"],
            ["budget OR invoice", "Either word"],
            ["{from:amy to:amy}", "Any of these"],
          ].map(([k, d]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

function Choice<K extends keyof Settings>({
  k,
  options,
  label,
}: {
  k: K;
  options: [Settings[K], string][];
  label: string;
}) {
  const s = getSettings();
  return (
    <fieldset className="setting">
      <legend>{label}</legend>
      {options.map(([v, l]) => (
        <label key={String(v)} className="radio">
          <input
            type="radio"
            name={k}
            checked={s[k] === v}
            onChange={() => setSettings({ [k]: v } as Partial<Settings>)}
          />
          {l}
        </label>
      ))}
    </fieldset>
  );
}

export function SettingsDialog({ onClose, smartAvailable }: { onClose: () => void; smartAvailable: boolean }) {
  useStore();
  const s = getSettings();
  return (
    <Dialog title="Settings" onClose={onClose}>
      <Choice
        k="density"
        label="Density"
        options={[
          ["default", "Default"],
          ["comfortable", "Comfortable"],
          ["compact", "Compact"],
        ]}
      />
      <Choice
        k="theme"
        label="Theme"
        options={[
          ["system", "Match system"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]}
      />
      <Choice
        k="pageSize"
        label="Conversations per page"
        options={[
          [25, "25"],
          [50, "50"],
          [100, "100"],
        ]}
      />
      <fieldset className="setting">
        <legend>Search</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={s.smart}
            disabled={!smartAvailable}
            onChange={(e) => setSettings({ smart: e.target.checked })}
          />
          <span>
            Smart search: also find messages with similar meaning
            <small>
              {smartAvailable
                ? "Downloads a 23 MB language model once; runs on this device, nothing is sent anywhere."
                : "This mailbox was built without semantic vectors."}
            </small>
          </span>
        </label>
      </fieldset>
      <fieldset className="setting">
        <legend>Images</legend>
        <label className="check">
          <input type="checkbox" checked={s.images} onChange={(e) => setSettings({ images: e.target.checked })} />
          <span>
            Always display external images
            <small>
              Off by default: loading remote images can tell the original sender that the message was opened.
            </small>
          </span>
        </label>
      </fieldset>
    </Dialog>
  );
}

export function AboutDialog({ ds, onClose }: { ds: Dataset; onClose: () => void }) {
  const m = ds.manifest;
  const range = m.date_range
    ? `${new Date(m.date_range[0]).toLocaleDateString()} – ${new Date(m.date_range[1]).toLocaleDateString()}`
    : "—";
  const files = Object.entries(m.files);
  const msgUrl = ds.url("messages");
  return (
    <Dialog title={m.title} onClose={onClose} wide>
      {m.description && <p className="about-desc">{m.description}</p>}
      <div className="stats">
        <div>
          <b>{m.counts.messages.toLocaleString()}</b>
          <span>messages</span>
        </div>
        <div>
          <b>{m.counts.threads.toLocaleString()}</b>
          <span>conversations</span>
        </div>
        <div>
          <b>{m.counts.attachments.toLocaleString()}</b>
          <span>attachments</span>
        </div>
        <div>
          <b>{range}</b>
          <span>date range</span>
        </div>
      </div>
      <table className="kv">
        <tbody>
          {m.owner && (
            <tr>
              <td>Mailbox owner</td>
              <td>
                {m.owner.name ? `${m.owner.name} <${m.owner.addr}>` : m.owner.addr} <small>(detected)</small>
              </td>
            </tr>
          )}
          <tr>
            <td>Folders</td>
            <td>{m.labels.map((l) => `${l.name} (${l.count.toLocaleString()})`).join(", ")}</td>
          </tr>
          <tr>
            <td>Built</td>
            <td>
              {fullDate(Date.parse(m.built_at), false)} with {m.generator}
            </td>
          </tr>
          {m.counts.duplicates_merged > 0 && (
            <tr>
              <td>Duplicates merged</td>
              <td>{m.counts.duplicates_merged.toLocaleString()}</td>
            </tr>
          )}
          <tr>
            <td>Search</td>
            <td>Word index{m.embedding ? ` + smart search (${m.embedding.model})` : ""}</td>
          </tr>
        </tbody>
      </table>
      <h3>
        <Icon name="database" size={18} /> Open data
      </h3>
      <p className="muted-text">Every table is a Parquet file you can query directly, for example with DuckDB:</p>
      <pre className="code">{`SELECT to_timestamp(ts / 1000) AS sent, from_name, subject
FROM '${msgUrl}'
ORDER BY ts DESC LIMIT 20;`}</pre>
      <ul className="files">
        {files.map(([k, f]) => (
          <li key={k}>
            <a href={ds.base + f} target="_blank" rel="noopener noreferrer">
              {f}
            </a>{" "}
            <span className="muted-text">{k}</span>
          </li>
        ))}
      </ul>
      <p className="muted-text small">Read and starred marks are kept only in this browser.</p>
    </Dialog>
  );
}
