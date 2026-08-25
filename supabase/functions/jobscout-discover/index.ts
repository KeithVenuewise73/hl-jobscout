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
import { authorize, type TokenStore } from "../_shared/auth.ts";
import { findCareersPage, type FetchPage } from "../_shared/discover.ts";
import { validateRedirect, validateUrl } from "../_shared/url.ts";

// Sized against what the edge runtime will actually tolerate, not against what
// would be convenient. The first real run asked for 60 companies x up to 9 page
// fetches, buffered whole pages (200-280KB each), and was killed with
// WORKER_RESOURCE_LIMIT after four. Small batches, hard caps, run more often.
const BUDGET_MS = Number(Deno.env.get("JOBSCOUT_DISCOVER_BUDGET_MS") ?? 60_000);
const BATCH = Number(Deno.env.get("JOBSCOUT_DISCOVER_BATCH") ?? 3);
const PER_COMPANY_MS = Number(Deno.env.get("JOBSCOUT_DISCOVER_COMPANY_MS") ?? 20_000);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124 Safari/537.36";
// An ATS link is a short string in the markup. 400KB of any careers page is far
// more than enough to find one, and buffering more is what killed the worker.
const MAX_HTML = 200 * 1024;
const PAGE_TIMEOUT_MS = 10_000;

// Careers pages are arbitrary third-party URLs, so every hop is SSRF-checked.
const fetchPage: FetchPage = async (url) => {
  let current = validateUrl(url).toString();
  for (let hop = 0; hop <= 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
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
    // Read only up to the cap, then hang up. res.text() would pull the whole
    // body into memory first and slicing afterwards is too late.
    const html = await readCapped(res, MAX_HTML);
    return { html, finalUrl: current };
  }
  throw new Error("too_many_redirects");
};

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    out += dec.decode(value, { stream: true });
    if (total >= max) {
      await reader.cancel();
      break;
    }
  }
  return out;
}

// The expected run token, read over the service-role connection. Absent until
// the schedule migration is applied, which is what arms the check.
const tokenStore = (admin: {
  from: (t: string) => {
    select: (c: string) => { limit: (n: number) => Promise<{ data: unknown; error: unknown }> };
  };
}): TokenStore => ({
  async expected() {
    const { data, error } = await admin.from("runtime").select("cron_token").limit(1);
    // A missing table means the migration has not been applied yet, which is
    // "not configured", not "broken".
    if (error) {
      const msg = String((error as { message?: string }).message ?? error);
      if (/does not exist|schema cache|relation/i.test(msg)) return null;
      throw new Error(msg);
    }
    const rows = data as { cron_token?: string }[] | null;
    return rows?.[0]?.cron_token ?? null;
  },
});

Deno.serve(async (req) => {
  const started = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  // A valid JWT is necessary and not sufficient: the anon key is public.
  const auth = await authorize(req, tokenStore(admin));
  if (!auth.ok) return json({ ok: false, error: auth.reason }, 401);

  // Never-attempted companies FIRST, then the oldest retries.
  //
  // Deliberately two queries rather than one ordered by discover_attempted_at
  // with nullsFirst. Postgres sorts NULL LAST in ascending order, and the live
  // run proved the client's nullsFirst did not change that: 21 of 58 employers
  // sat permanently at the bottom of the queue while the same handful were
  // re-crawled twice a day, and every run reported success. A silent gap in
  // coverage is the worst failure this thing can have, so it does not rely on
  // NULL-ordering semantics at all.
  const base = () =>
    admin.from("companies").select("id,name,website,ats")
      .eq("active", true)
      .not("website", "is", null)
      .or("ats.is.null,ats.eq.unknown");

  const { data: fresh, error } = await base()
    .is("discover_attempted_at", null)
    .order("priority", { ascending: true })
    .limit(BATCH);
  if (error) return json({ ok: false, error: error.message }, 500);

  const pending = [...(fresh ?? [])];
  if (pending.length < BATCH) {
    const { data: retries, error: rErr } = await base()
      .not("discover_attempted_at", "is", null)
      .order("discover_attempted_at", { ascending: true })
      .limit(BATCH - pending.length);
    if (rErr) return json({ ok: false, error: rErr.message }, 500);
    pending.push(...(retries ?? []));
  }

  const detail: unknown[] = [];
  let resolved = 0, deferred = 0;

  for (const c of pending) {
    if (Date.now() - started > BUDGET_MS) {
      deferred = pending.length - detail.length;
      break;
    }
    const det = await findCareersPage(c.website as string, fetchPage, {
      deadlineMs: PER_COMPANY_MS,
    });
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

  const { count: stillPending } = await admin
    .from("companies")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .not("website", "is", null)
    .or("ats.is.null,ats.eq.unknown");

  const { count: neverTried } = await admin
    .from("companies")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .not("website", "is", null)
    .is("discover_attempted_at", null);

  const report = {
    elapsed_ms: Date.now() - started,
    attempted: detail.length,
    deferred_this_batch: deferred,
    // Unresolved across the WHOLE list, so a caller knows to run again.
    still_unresolved: stillPending ?? null,
    // If this never reaches 0, coverage is stuck — that is the number to watch.
    never_attempted: neverTried ?? null,
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
