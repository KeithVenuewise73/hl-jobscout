import { assertEquals } from "./assert.ts";
import { pageHeaders, passThrough, upstreamFor } from "../../../apps/viewer/relay.ts";

const BASE = "https://proj.supabase.co/functions/v1/jobscout-dashboard";

Deno.test("the token is carried through to the upstream", () => {
  assertEquals(upstreamFor(BASE, "abc123"), `${BASE}?k=abc123`);
});

Deno.test("a missing token is not invented", () => {
  // Passing no k must reach Supabase as no k, so IT decides — not this app.
  assertEquals(upstreamFor(BASE, null), BASE);
});

Deno.test("a crafted token cannot add a second parameter", () => {
  // The whole risk of building a URL by concatenation: "&publish=1" tacked on
  // the end of a token would become a separate parameter.
  const out = new URL(upstreamFor(BASE, "abc&publish=1"));
  assertEquals(out.searchParams.get("k"), "abc&publish=1");
  assertEquals(out.searchParams.get("publish"), null);
});

Deno.test("a crafted token cannot redirect the request elsewhere", () => {
  const out = new URL(upstreamFor(BASE, "x#@evil.example.com"));
  assertEquals(out.host, "proj.supabase.co");
  assertEquals(out.pathname, "/functions/v1/jobscout-dashboard");
});

Deno.test("an upstream query string is not inherited", () => {
  // If the configured upstream ever carried its own ?k=, the visitor's token
  // must replace it rather than sit alongside it.
  assertEquals(upstreamFor(`${BASE}?k=stale`, "fresh"), `${BASE}?k=fresh`);
});

Deno.test("the page is served as HTML, which is the entire reason this exists", () => {
  const h = pageHeaders() as Record<string, string>;
  assertEquals(h["content-type"], "text/html; charset=utf-8");
});

Deno.test("the token is not handed to the employers he clicks through to", () => {
  const h = pageHeaders() as Record<string, string>;
  assertEquals(h["referrer-policy"], "no-referrer");
  assertEquals(h["cache-control"], "no-store");
});

Deno.test("a rejected token stays a bare 404", () => {
  // Rendering a friendly page for a bad token would confirm to whoever is
  // probing that the address is real.
  assertEquals(passThrough(404), true);
  assertEquals(passThrough(503), true);
  assertEquals(passThrough(200), false);
});
