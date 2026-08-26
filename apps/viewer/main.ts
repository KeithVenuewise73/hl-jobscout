// jobscout-viewer — serves the shortlist page on Keith's own domain.
//
// WIRING ONLY. Everything it decides lives in relay.ts; everything the PAGE
// decides still lives in Supabase, which this does not duplicate.
//
// Configuration is one environment variable:
//   JOBSCOUT_UPSTREAM   the jobscout-dashboard function URL, without ?k=
//
// There is no second variable, and in particular no key: the bookmark carries
// the view token and Supabase checks it.

import { pageHeaders, passThrough, upstreamFor } from "./relay.ts";

const UPSTREAM = Deno.env.get("JOBSCOUT_UPSTREAM");
const PORT = Number(Deno.env.get("PORT") ?? 8000);

if (!UPSTREAM) {
  // Fail at startup, loudly. A viewer that boots without knowing where to look
  // would serve a plausible error page forever and read as "no jobs today".
  console.error("JOBSCOUT_UPSTREAM is not set — refusing to start.");
  Deno.exit(1);
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // Coolify wants something to poll that does not depend on Supabase being up.
  if (url.pathname === "/health") return new Response("ok");

  const target = upstreamFor(UPSTREAM, url.searchParams.get("k"));

  try {
    if (req.method === "POST") {
      // Applied / Not interested. Forwarded verbatim; Supabase validates both
      // the token and the status, and rewrites the stored page.
      const r = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await req.text(),
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // redirect: "follow" is what does the real work — the function answers 303
    // and points at the stored file; we want the file's bytes.
    const r = await fetch(target, { redirect: "follow" });
    const body = await r.text();
    if (passThrough(r.status)) {
      return new Response(body, {
        status: r.status,
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
    return new Response(body, { headers: pageHeaders() });
  } catch (e) {
    // Never a blank page. If Supabase is unreachable, say that, because the
    // alternative reads as "there are no jobs".
    return new Response(
      `Could not reach JobScout: ${(e as Error).message}\n\n` +
        `The shortlist itself is fine — this is the connection to it.`,
      { status: 502, headers: { "content-type": "text/plain" } },
    );
  }
});

console.log(`jobscout-viewer listening on :${PORT}`);
