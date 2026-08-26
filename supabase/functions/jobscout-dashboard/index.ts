// jobscout-dashboard — the page Keith opens.
//
// WIRING ONLY; every decision about what the page says lives in
// ../_shared/dashboard.ts and is tested offline.
//
// TWO DELIBERATE DEPARTURES FROM THE OTHER FUNCTIONS, both because a browser
// is opening this rather than pg_cron:
//
//   * verify_jwt is OFF. A browser cannot attach an Authorization header when
//     you click a bookmark, so a JWT-gated page is a page nobody can open.
//     Access is the token in the URL instead.
//   * That token is view_token, NOT the cron token. A bookmark ends up in
//     history, in a synced browser profile, in a screenshot. Whoever holds this
//     one can read the shortlist and mark a job applied; they cannot start a
//     crawl or a scoring run, because that needs the other token, which never
//     leaves the database.
//
// The browser receives rendered HTML and no credential of any kind. Everything
// is read here, server-side, over the service-role connection.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  renderPage, type Coverage, type RunRow, type ShortlistRow,
} from "../_shared/dashboard.ts";
import { tokenMatches } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  const given = new URL(req.url).searchParams.get("k");
  const { data: rt, error: rtErr } = await admin
    .from("runtime").select("view_token").limit(1);
  if (rtErr) return text(`configuration unreadable: ${rtErr.message}`, 500);
  const expected = (rt as { view_token?: string }[] | null)?.[0]?.view_token ?? null;
  if (!expected) return text("No view token is configured yet.", 503);
  if (!tokenMatches(given, expected)) return text("Not found.", 404);

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
      ids.map((job_id) => ({ job_id, status, updated_at: new Date().toISOString() })),
      { onConflict: "job_id" },
    );
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, updated: ids.length });
  }

  // ---- the page ----
  const [shortlist, jobs, runs, companies] = await Promise.all([
    admin.from("v_shortlist").select("*").order("fit_score", { ascending: false }).limit(300),
    // v_shortlist carries no company_id, and grouping needs one — two rows are
    // the same job only if they are at the same EMPLOYER.
    admin.from("jobs").select("id,company_id"),
    admin.from("v_last_runs").select("*"),
    admin.from("companies").select("id,ats,active"),
  ]);

  const firstError = [shortlist, jobs, runs, companies].find((r) => r.error)?.error;
  if (firstError) return text(`could not read the shortlist: ${firstError.message}`, 500);

  const companyOf = new Map(
    ((jobs.data ?? []) as { id: number; company_id: number }[])
      .map((j) => [j.id, j.company_id]),
  );
  const rows = ((shortlist.data ?? []) as Record<string, unknown>[]).map((r) => ({
    ...r,
    company_id: companyOf.get(r.job_id as number) ?? -1,
  })) as ShortlistRow[];

  const cos = (companies.data ?? []) as { ats: string | null; active: boolean }[];
  const CRAWLABLE = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "adp"];
  const active = cos.filter((c) => c.active);
  const coverage: Coverage = {
    employers_total: active.length,
    employers_crawlable: active.filter((c) => CRAWLABLE.includes(c.ats ?? "")).length,
    employers_no_ats: active.filter((c) => !c.ats || c.ats === "unknown").length,
    open_jobs: rows.length,
    sources: [...new Set(rows.map((r) => r.source ?? "?"))].sort(),
  };

  const html = renderPage({
    rows,
    runs: (runs.data ?? []) as RunRow[],
    coverage,
    now: new Date().toISOString(),
  });

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page holds a live token in its URL; keep it out of caches and out
      // of the Referer header on the outbound "Open posting" clicks.
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
