import { useEffect, useState } from "react";
import { DATA_URL, listDatasets } from "../lib/dataset";
import { mailboxPath, site } from "../lib/site";
import type { DatasetEntry } from "../lib/types";
import { Icon } from "./Icon";

export function Home() {
  const [list, setList] = useState<DatasetEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = "Mailbox Viewer";
    listDatasets()
      .then((l) => {
        if (l.length === 1) location.replace(mailboxPath(l[0].slug));
        else setList(l);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <SetupHelp error={error} />;
  if (!list)
    return (
      <div className="splash">
        <span className="spinner" />
      </div>
    );
  return (
    <div className="home">
      <div className="home-card">
        <div className="brand big">
          <img src={site("favicon.svg")} alt="" width={40} height={40} /> Mailbox Viewer
        </div>
        <h1>Choose a mailbox</h1>
        {list.length === 0 && (
          <p className="muted-text">
            No mailboxes published yet. Run <code>uv run mbv build</code> and <code>uv run mbv publish</code>.
          </p>
        )}
        <div className="ds-list">
          {list.map((d) => (
            <a key={d.slug} className="ds-item" href={mailboxPath(d.slug)}>
              <span className="ds-avatar">{(d.title[0] || "?").toUpperCase()}</span>
              <span className="ds-main">
                <span className="ds-title">{d.title}</span>
                <span className="ds-sub">
                  {list.filter((x) => x.title === d.title).length > 1 && `${d.slug} · `}
                  {d.messages.toLocaleString()} messages
                  {d.date_range &&
                    ` · ${new Date(d.date_range[0]).getFullYear()}–${new Date(d.date_range[1]).getFullYear()}`}
                  {d.description && ` · ${d.description}`}
                </span>
              </span>
              <Icon name="chevron_right" size={20} />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SetupHelp({ error }: { error: string }) {
  const local = DATA_URL === site("data");
  return (
    <div className="home">
      <div className="home-card">
        <div className="brand big">
          <img src={site("favicon.svg")} alt="" width={40} height={40} /> Mailbox Viewer
        </div>
        <h1>Can't reach the mailbox data</h1>
        <p className="error-box">{error}</p>
        {local ? (
          <p>
            Running locally: build a dataset with <code>uv run mbv build input/... --slug name</code>, then start{" "}
            <code>uv run mbv preview</code>.
          </p>
        ) : (
          <ul className="help-list">
            <li>
              <b>Data URL</b>: this site reads from <code>{DATA_URL}</code> (the <code>VITE_DATA_URL</code> setting).
            </li>
            <li>
              <b>Published?</b> Run <code>uv run mbv publish --all</code>; it uploads <code>datasets.json</code>.
            </li>
            <li>
              <b>CORS</b>: the bucket must allow GET/HEAD with the Range header. <code>uv run mbv check</code> tests it.
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
