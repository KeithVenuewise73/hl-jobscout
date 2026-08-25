// jobscout-ingest — pulls postings directly from employer career boards.
//
// This file is WIRING ONLY. Every decision — which companies are due, what
// counts as a stale posting, when a failure must NOT close a board — lives in
// ../_shared/ingest.ts, which is fully exercised offline by
// ../tests/ingest.test.ts. Nothing here can decide anything on its own.
//
// Scheduled by supabase/migrations/0002_jobscout_schedule.sql. One invocation
// crawls what it can inside a wall-clock budget; companies are ordered
// oldest-crawl-first, so successive runs rotate through the list with no
// cursor to lose.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorize, type TokenStore } from "../_shared/auth.ts";
import { ADAPTERS, type Company } from "../_shared/adapters.ts";
import { makeClient } from "../_shared/http.ts";
import { runIngest, type Db, type JobRow } from "../_shared/ingest.ts";

const BUDGET_MS = Number(Deno.env.get("JOBSCOUT_INGEST_BUDGET_MS") ?? 120_000);

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
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  // A valid JWT is necessary and not sufficient: the anon key is public.
  const auth = await authorize(req, tokenStore(admin));
  if (!auth.ok) return json({ ok: false, error: auth.reason }, 401);

  const db: Db = {
    async dueCompanies(limit) {
      const { data, error } = await admin
        .from("companies")
        .select("*")
        .eq("active", true)
        .in("ats", Object.keys(ADAPTERS))
        .not("board_token", "is", null)
        .order("last_crawled_at", { ascending: true, nullsFirst: true })
        .order("priority", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as Company[];
    },
    async upsertJobs(rows: JobRow[]) {
      const { error } = await admin
        .from("jobs")
        .upsert(rows, { onConflict: "company_id,ats_job_id" });
      if (error) throw new Error(error.message);
    },
    async closeStale(companyId, before, source) {
      const { data, error } = await admin
        .from("jobs")
        .update({ is_open: false })
        .eq("company_id", companyId)
        // Only what this crawler owns. Without it an ATS crawl closes the
        // alert-sourced rows for the same employer, which it has never seen.
        .eq("source", source)
        .eq("is_open", true)
        .lt("last_seen", before)
        .select("id");
      if (error) throw new Error(error.message);
      return data?.length ?? 0;
    },
    async markCrawled(companyId, at) {
      const { error } = await admin
        .from("companies")
        .update({ last_crawled_at: at })
        .eq("id", companyId);
      if (error) throw new Error(error.message);
    },
  };

  try {
    const report = await runIngest({ db, http: makeClient(), budgetMs: BUDGET_MS });
    await admin.from("runs").insert({
      kind: "ingest",
      ok: report.errors === 0,
      report,
    });
    return json({ ok: true, ...report });
  } catch (e) {
    const err = e as Error;
    await admin.from("runs").insert({
      kind: "ingest", ok: false, report: { error: `${err.name}: ${err.message}` },
    });
    return json({ ok: false, error: `${err.name}: ${err.message}` }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
