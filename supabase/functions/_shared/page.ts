// Building the page, and putting it where a browser can render it.
//
// WHY THIS FILE EXISTS, AND WHAT IS STILL BROKEN
//
// The dashboard was first served straight out of an edge function. That works
// in curl and fails in a browser: the response comes back rewritten to
//     content-type: text/plain
//     x-content-type-options: nosniff
//     content-security-policy: default-src 'none'; sandbox
// so the page arrives as source code, and no stylesheet or script would run
// even if it did not. It is not a bug in the function — it is the platform
// declining to host HTML on a domain shared by every Supabase project.
//
// Moving the page into Storage did NOT fix that, and the comment here used to
// claim it would. Measured, on this project, on the same file:
//
//     GET /functions/v1/jobscout-dashboard      -> text/plain, nosniff, sandbox
//     GET /storage/v1/object/public/dash/...    -> text/plain, nosniff, sandbox
//     GET /storage/v1/object/sign/dash/...?tok  -> text/plain, nosniff, sandbox
//
// Three different code paths, one answer. Nothing served from *.supabase.co
// renders as HTML, so the page needs a host that will — that is apps/viewer,
// which runs on Keith's own server and forwards to this project.
//
// WHAT THIS ARRANGEMENT BUYS
//
// The page is a file, and the function redirects to it. Supabase stays the
// only thing that decides anything; the viewer is a content-type fixer holding
// no credentials. The bookmark points at the viewer, so the page can move
// again without the bookmark changing.
//
// The cost is honesty about time: a file is a snapshot. It is stamped with
// when it was written, and the run ages on it correct themselves against the
// real clock in the browser.

import {
  type Coverage, type PageData, renderPage, type RunRow, type ShortlistRow,
} from "./dashboard.ts";

export const BUCKET = "dash";
export const OBJECT = "index.html";

/** Adapters we can actually read a job board through. */
export const CRAWLABLE = [
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday", "adp",
];

export interface CompanyRow {
  ats: string | null;
  active: boolean;
}

/**
 * What the page can and cannot see. Pure, and tested, because this is the
 * panel that keeps an empty shortlist from reading as "nothing is out there"
 * when the truth is "we are only watching a fifth of the list".
 */
export function coverageOf(
  rows: ShortlistRow[],
  companies: CompanyRow[],
): Coverage {
  const active = companies.filter((c) => c.active);
  return {
    employers_total: active.length,
    employers_crawlable: active.filter((c) =>
      CRAWLABLE.includes(c.ats ?? "")
    ).length,
    employers_no_ats: active.filter((c) => !c.ats || c.ats === "unknown").length,
    open_jobs: rows.length,
    sources: [...new Set(rows.map((r) => r.source ?? "?"))].sort(),
  };
}

/** The public URL a stored page is served from. Stable, so a bookmark keeps. */
export function pageUrl(supabaseUrl: string, token: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}` +
    `/storage/v1/object/public/${BUCKET}/${token}/${OBJECT}`;
}

/**
 * Where the page's buttons POST: nowhere in particular, which is the point.
 *
 * An absolute Supabase URL was the obvious choice and the wrong one. The page
 * is served from Keith's own domain by apps/viewer, so an absolute URL back to
 * supabase.co makes every click a cross-origin request and CORS refuses it.
 * Empty means "post to whatever URL served me" — the viewer, which forwards.
 *
 * Keeping it a named function rather than a bare "" so the reasoning has
 * somewhere to live.
 */
export function endpointUrl(): string {
  return "";
}

// ---- the wiring ------------------------------------------------------------
//
// Below here is Supabase-specific and not unit-tested; everything it decides
// was decided above or in dashboard.ts.

// deno-lint-ignore no-explicit-any
type Admin = any;

export async function collect(
  admin: Admin,
  opts: { now: string; endpoint: string; published_at?: string },
): Promise<PageData> {
  const [shortlist, jobs, runs, companies] = await Promise.all([
    admin.from("v_shortlist").select("*")
      .order("fit_score", { ascending: false }).limit(300),
    // v_shortlist carries no company_id, and grouping needs one — two rows are
    // the same job only if they are at the same EMPLOYER.
    admin.from("jobs").select("id,company_id"),
    admin.from("v_last_runs").select("*"),
    admin.from("companies").select("id,ats,active"),
  ]);

  const bad = [shortlist, jobs, runs, companies].find((r: Admin) => r.error);
  if (bad) throw new Error(bad.error.message);

  const companyOf = new Map<number, number>(
    (jobs.data ?? []).map((j: { id: number; company_id: number }) =>
      [j.id, j.company_id]
    ),
  );
  const rows = (shortlist.data ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    company_id: companyOf.get(r.job_id as number) ?? -1,
  })) as ShortlistRow[];

  return {
    rows,
    runs: (runs.data ?? []) as RunRow[],
    coverage: coverageOf(rows, (companies.data ?? []) as CompanyRow[]),
    now: opts.now,
    endpoint: opts.endpoint,
    published_at: opts.published_at,
  };
}

/**
 * Render and store. Returns the URL the page is readable at.
 *
 * upsert is on: the bookmark must not change, so the same object is rewritten
 * every time. cacheControl is 0 because a cached copy of this page is a page
 * that lies about when it last ran.
 */
export async function publish(
  admin: Admin,
  supabaseUrl: string,
  token: string,
  now: string,
): Promise<string> {
  const data = await collect(admin, {
    now,
    endpoint: endpointUrl(),
    published_at: now,
  });
  const html = renderPage(data);
  const { error } = await admin.storage.from(BUCKET).upload(
    `${token}/${OBJECT}`,
    new Blob([html], { type: "text/html; charset=utf-8" }),
    { contentType: "text/html; charset=utf-8", upsert: true, cacheControl: "0" },
  );
  if (error) throw new Error(`could not write the page: ${error.message}`);
  return pageUrl(supabaseUrl, token);
}
