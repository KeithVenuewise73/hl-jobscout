// jobscout-dashboard — the endpoint behind the page.
//
// WIRING ONLY; every decision about what the page says lives in
// ../_shared/dashboard.ts and ../_shared/page.ts, and is tested offline.
//
// THIS FUNCTION DOES NOT SERVE THE PAGE, AND CANNOT.
//
// Supabase rewrites a text/html response to text/plain, with nosniff and a
// sandbox CSP, on the shared functions domain — so the first version of this
// arrived in the browser as source code. Storage does the same, on both public
// and signed URLs. The page is therefore written to Storage and served to a
// browser by apps/viewer, on a domain that renders HTML; this endpoint does
// the three things a file cannot:
//
//   POST + x-jobscout-token   rewrite the stored page. This is cron.
//   GET  + ?k=<view_token>    redirect to it, so the original bookmark lives.
//   POST + ?k=<view_token>    mark a job applied / not interested, then
//                             rewrite the page so a reload shows the decision.
//
// TWO TOKENS, AND THE DIFFERENCE MATTERS. view_token travels in a URL, which
// means it ends up in browser history, in a synced profile, in a screenshot.
// Whoever holds it can read the shortlist and mark a job. It cannot start a
// crawl or a scoring run — those cost money and need cron_token, which never
// leaves the database.
//
// verify_jwt is OFF because a browser cannot attach an Authorization header
// when you click a bookmark. The tokens above are the access control.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { CRON_HEADER, tokenMatches } from "../_shared/auth.ts";
import { pageUrl, publish } from "../_shared/page.ts";

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    db: { schema: "jobscout" },
  });

  const { data: rt, error: rtErr } = await admin
    .from("runtime").select("view_token,cron_token").limit(1);
  if (rtErr) return text(`configuration unreadable: ${rtErr.message}`, 500);
  const cfg = (rt as { view_token?: string; cron_token?: string }[] | null)?.[0];
  const view = cfg?.view_token ?? null;
  if (!view) return text("No view token is configured yet.", 503);

  const now = () => new Date().toISOString();

  // ---- cron: rewrite the stored page ----
  if (tokenMatches(req.headers.get(CRON_HEADER), cfg?.cron_token ?? null)) {
    try {
      // Logged, not returned: the caller is cron, and cron reads nothing.
      console.log("published", await publish(admin, url, view, now()));
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  const given = new URL(req.url).searchParams.get("k");
  if (!tokenMatches(given, view)) return text("Not found.", 404);

  // ---- marking a job applied / not interested ----
  if (req.method === "POST") {
    let body: { job_ids?: number[]; status?: string };
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "expected JSON" }, 400);
    }
    const ids = (body.job_ids ?? []).filter((n) => Number.isInteger(n));
    const status = String(body.status ?? "");
    // A closed set, so a crafted request cannot write arbitrary text into a
    // column the page then renders back.
    if (!ids.length || !["applied", "dismissed", "new"].includes(status)) {
      return json({ ok: false, error: "job_ids and a known status are required" }, 400);
    }
    // Every copy of the job moves together — they are one opportunity, and
    // marking one applied while its twin still reads "new" is the duplicate
    // problem wearing a different hat.
    const { error } = await admin.from("applications").upsert(
      ids.map((job_id) => ({ job_id, status, updated_at: now() })),
      { onConflict: "job_id" },
    );
    if (error) return json({ ok: false, error: error.message }, 500);

    // The page is a file. Without this the click is saved and the file still
    // reads "new" until the next scheduled run, which looks exactly like a
    // button that did nothing.
    try {
      await publish(admin, url, view, now());
    } catch (e) {
      // The decision IS saved. Say that, and say what did not happen, rather
      // than reporting a failure that would have him click it again.
      return json({
        ok: true,
        updated: ids.length,
        warning: `saved, but the page could not be rewritten: ${(e as Error).message}`,
      });
    }
    return json({ ok: true, updated: ids.length });
  }

  // ---- the page ----
  // 303 so the browser follows with GET, uncached so this keeps working if the
  // page ever moves again.
  return new Response(null, {
    status: 303,
    headers: {
      location: pageUrl(url, view),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
});

function text(msg: string, status: number) {
  return new Response(msg, { status, headers: { "content-type": "text/plain" } });
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
