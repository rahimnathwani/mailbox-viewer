// The viewer can live at the site root or under a sub-path (VITE_BASE, e.g. GitHub Pages project sites).
export const BASE = import.meta.env.BASE_URL; // always ends with "/"

/** Absolute URL path of a page or file inside the viewer: site("demo") → "/mailbox-viewer/demo" */
export const site = (path = "") => BASE + path.replace(/^\/+/, "");

/** Absolute URL (with origin) of a viewer path, for links copied out of the page. */
export const siteUrl = (path = "") => new URL(site(path), location.origin).href;

/** The mailbox slug from the address bar, ignoring the base path. */
export function currentSlug(): string {
  const rest = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  return decodeURIComponent(rest.replace(/^\/+|\/+$/g, "").split("/")[0] || "");
}

export const mailboxPath = (slug: string) => site(encodeURIComponent(slug));
