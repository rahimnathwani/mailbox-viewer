import { Component, type ReactNode } from "react";
import { Home } from "./components/Home";
import { MailboxApp } from "./components/MailboxApp";
import { currentSlug } from "./lib/site";

/** Anything unexpected in the data shows a message instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="home">
        <div className="home-card">
          <h1>Something went wrong</h1>
          <p className="error-box">{this.state.error.message}</p>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              location.hash = "";
              location.reload();
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

/** "/" lists mailboxes; "/<slug>" opens one (Vercel rewrites every path to index.html). */
export function App() {
  const slug = currentSlug();
  return <ErrorBoundary>{slug ? <MailboxApp slug={slug} /> : <Home />}</ErrorBoundary>;
}
