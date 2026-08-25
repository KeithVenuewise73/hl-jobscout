// jobscout-discover — resolves companies with an unknown ATS to a board token.
//
// WIRING ONLY; the detection lives in ../_shared/discover.ts (tested offline by
// ../tests/discover.test.ts).
//
// Runs against companies whose ats is null/'unknown', oldest attempt first, so
// repeated runs work through the list. A company that resolves to an ATS we
// cannot ingest is still recorded — it stays on the target list, it just needs
// an adapter or a bookmark rather than a crawler.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { findCareersPage, type FetchPage } from "../_shared/discover.ts";
import { validateRedirect, validateUrl } from "../_shared/url.ts";

const BUDGET_MS = Number(Deno.env.get("JOBSCOUT_DISCOVER_BUDGET_MS") ?? 120_000);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124 Safari/537.36";
const MAX_HTML = 2 * 1024 * 1024;

// Careers pages are arbitrary third-party URLs, so every hop is SSRF-checked.
const fetchPage: FetchPage = async (url) => {
  let current = validateUrl(url).toString();
  for (let hop = 0; hop <= 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(current, {
        headers: { "User-Agent": UA },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      res.body?.cancel();
      if (!loc) throw new Error("redirect_without_location");
      current = validateRedirect(loc, current).toString();
      continue;
    }
    if (res.status >= 400) {
      res.body?.cancel();
      throw new Error(`http_${res.status}`);
    }
    const html = (await res.text()).slice(0, MAX_HTML);
    return { html, finalUrl: current };
  }
  throw new Error("too_many_redirects");
};

Deno.serve(async () => {
  const started = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  const { data: pending, error } = await admin
    .from("companies")
    .select("id,name,website,ats")
    .eq("active", true)
    .not("website", "is", null)
    .or("ats.is.null,ats.eq.unknown")
    .order("discover_attempted_at", { ascending: true, nullsFirst: true })
    .order("priority", { ascending: true })
    .limit(60);
  if (error) return json({ ok: false, error: error.message }, 500);

  const detail: unknown[] = [];
  let resolved = 0, deferred = 0;

  for (const c of pending ?? []) {
    if (Date.now() - started > BUDGET_MS) {
      deferred = (pending?.length ?? 0) - detail.length;
      break;
    }
    const det = await findCareersPage(c.website as string, fetchPage);
    const { error: upErr } = await admin.from("companies").update({
      ats: det.ats,
      board_token: det.board_token,
      workday_host: det.workday_host ?? null,
      workday_site: det.workday_site ?? null,
      careers_url: det.careers_url ?? null,
      discover_evidence: det.evidence,
      discover_attempted_at: new Date().toISOString(),
    }).eq("id", c.id);
    if (det.supported) resolved++;
    detail.push({
      company: c.name, ats: det.ats, token: det.board_token,
      supported: det.supported, evidence: det.evidence,
      ...(upErr ? { write_error: upErr.message } : {}),
    });
  }

  const report = {
    elapsed_ms: Date.now() - started,
    attempted: detail.length,
    deferred_to_next_run: deferred,
    ingestible_today: resolved,
    detail,
  };
  await admin.from("runs").insert({ kind: "discover", ok: true, report });
  return json({ ok: true, ...report });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
