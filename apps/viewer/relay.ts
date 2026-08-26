// The decisions the viewer makes. Pure, so they can be tested without a
// server, a network, or Supabase.
//
// WHAT THIS APP IS FOR
//
// Supabase will not serve HTML. Every response from *.supabase.co — edge
// function, public Storage object, signed Storage URL alike — comes back as
// text/plain with nosniff and a sandbox CSP, because that domain is shared by
// every project and hosting a web page on it would be an XSS vector against
// everyone else on it. Measured on all three paths; it is a policy, not a bug.
//
// So this runs on Keith's own server, where his own domain sets its own rules.
// It is a content-type fixer and nothing else: it forwards the request to
// Supabase, which still decides everything, and hands back the same bytes with
// a content type a browser will render.
//
// IT HOLDS NO SECRETS, ON PURPOSE. The view token arrives in the query string
// from the bookmark and is passed straight through; Supabase checks it. A
// server that stores no credential cannot leak one, and this one has nothing
// to steal beyond what the visitor already typed.

/** The one URL this will ever talk to. Anything else is a bug or an attack. */
export function upstreamFor(base: string, k: string | null): string {
  const u = new URL(base);
  // Rebuilt from the base rather than concatenated, so a crafted `k` cannot
  // bolt a second query parameter, a fragment, or a new path onto the target.
  u.search = "";
  u.hash = "";
  if (k !== null) u.searchParams.set("k", k);
  return u.toString();
}

/**
 * The headers the browser gets back.
 *
 * `no-referrer` is not decoration. The page's own URL carries the view token,
 * and every "Open posting" link goes to a stranger's website — without this,
 * the token is handed to each of them in the Referer header.
 */
export function pageHeaders(): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    // The upstream response is HTML this repo generated, but it is assembled
    // from job titles and descriptions written by strangers. Belt and braces.
    "x-content-type-options": "nosniff",
  };
}

/**
 * Whether a status should be passed through as-is rather than rendered.
 *
 * A 404 from Supabase means a bad token and must stay a 404 — turning it into
 * a styled page would tell whoever is probing that they found something.
 */
export function passThrough(status: number): boolean {
  return status !== 200;
}
