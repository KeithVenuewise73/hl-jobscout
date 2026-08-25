// The deterministic ingest core.
//
// Every dependency — the database, the HTTP client, the clock — is injected, so
// this whole file is exercised offline by supabase/functions/tests/. The edge
// function around it (../jobscout-ingest/index.ts) only wires supabase-js to
// the Db interface below and adds nothing that can decide anything.

import { ADAPTERS, type Company, type Posting } from "./adapters.ts";
import type { FetchJson } from "./adapters.ts";
// titles.ts, NOT filters.ts: the title rules carry no gazetteer. See titles.ts.
import { titleOk } from "./titles.ts";

export interface JobRow {
  company_id: number;
  ats_job_id: string;
  title: string;
  location: string | null;
  department: string | null;
  url: string | null;
  description: string | null;
  comp_text: string | null;
  posted_at: string | null;
  last_seen: string;
  is_open: boolean;
}

/** The narrow slice of the database this core needs. */
export interface Db {
  /** Active, adapter-backed companies, oldest crawl first. */
  dueCompanies(limit: number): Promise<Company[]>;
  upsertJobs(rows: JobRow[]): Promise<void>;
  /**
   * Close this company's open ATS-sourced jobs whose last_seen predates
   * `before`. Returns the count.
   *
   * SCOPED BY SOURCE, and that is not a detail. A crawl knows what is on the
   * board it just read and nothing else. Closing every open row for the
   * company shut four alert-sourced jobs the crawler had never seen — among
   * them Epiq's "Director, Strategic Alliances", which a LinkedIn alert found
   * and which simply is not on Epiq's Workday board. A crawler may only close
   * what it is responsible for.
   */
  closeStale(companyId: number, before: string, source: string): Promise<number>;
  markCrawled(companyId: number, at: string): Promise<void>;
}

export interface CompanyResult {
  company: string;
  ats: string;
  seen: number;
  closed: number;
  /** Postings the title rules rejected before anything was written. */
  below_level?: number;
  error?: string;
}

export interface IngestReport {
  elapsed_ms: number;
  companies_crawled: number;
  companies_deferred_to_next_run: number;
  postings_seen: number;
  postings_closed: number;
  postings_below_level: number;
  errors: number;
  detail: CompanyResult[];
}

export interface IngestDeps {
  db: Db;
  http: FetchJson;
  now?: () => number;
  clock?: () => string;
  budgetMs?: number;
  limit?: number;
}

export function toRow(companyId: number, p: Posting, now: string): JobRow {
  return {
    company_id: companyId,
    ats_job_id: p.ats_job_id,
    title: (p.title ?? "").slice(0, 400),
    location: p.location?.slice(0, 300) || null,
    department: p.department,
    url: p.url,
    description: p.description?.slice(0, 40_000) || null,
    comp_text: p.comp_text,
    posted_at: p.posted_at,
    last_seen: now,
    is_open: true,
  };
}

export async function runIngest(deps: IngestDeps): Promise<IngestReport> {
  const now = deps.now ?? (() => Date.now());
  const clock = deps.clock ?? (() => new Date().toISOString());
  const budgetMs = deps.budgetMs ?? 120_000;
  const started = now();

  const companies = await deps.db.dueCompanies(deps.limit ?? 60);
  const results: CompanyResult[] = [];
  let deferred = 0;
  let filteredOut = 0;

  for (const c of companies) {
    if (now() - started > budgetMs) {
      deferred = companies.length - results.length;
      break;
    }
    const ats = (c.ats ?? "").toLowerCase();
    const fn = ADAPTERS[ats];
    if (!fn) continue;
    const name = c.name ?? "?";

    // Stamped before the fetch, so anything this run writes sorts after it.
    const runStart = clock();

    let postings: Posting[];
    try {
      postings = await fn(c, deps.http);
    } catch (e) {
      // A board that failed keeps every posting it had, and last_crawled_at is
      // left alone so the next run retries this company first.
      results.push({ company: name, ats, seen: 0, closed: 0, error: errText(e) });
      continue;
    }

    const stamp = clock();

    // Stage 1 runs HERE, at write time, not at score time.
    //
    // score.ts has always claimed this happened; it did not, and nothing was
    // filtering an ATS crawl at all. That was survivable while the only
    // crawlable boards were three Workday tenants. It stops being survivable
    // with ADP: Sonwil is a distribution centre whose board is mostly
    // warehouse shifts at $19.56/hour, and the scorer pays for every open
    // posting it has not already judged.
    //
    // Only the TITLE is judged here. These employers were put on the list for
    // being in range, so what a crawl needs to reject is a warehouse job, not
    // a distant one — and the radius gate is what would drag the gazetteer in.
    const usable = postings.filter((p) => p.ats_job_id);
    const kept = usable.filter((p) => titleOk(p.title));
    filteredOut += usable.length - kept.length;
    const rows = kept.map((p) => toRow(c.id!, p, stamp));

    try {
      if (rows.length) await deps.db.upsertJobs(rows);
    } catch (e) {
      // The write failed, so we do not know what is still on the board.
      // Closing anything now would empty it on a transient error.
      results.push({ company: name, ats, seen: rows.length, closed: 0, error: `upsert: ${errText(e)}` });
      continue;
    }

    let closed = 0;
    try {
      closed = await deps.db.closeStale(c.id!, runStart, "ats");
    } catch (e) {
      results.push({ company: name, ats, seen: rows.length, closed: 0, error: `close: ${errText(e)}` });
      continue;
    }

    try {
      await deps.db.markCrawled(c.id!, stamp);
    } catch {
      // Losing the stamp only costs us a re-crawl next run. Not worth failing.
    }
    results.push({
      company: name, ats, seen: rows.length, closed,
      below_level: usable.length - kept.length,
    });
  }

  return {
    elapsed_ms: now() - started,
    companies_crawled: results.length,
    // Never a silent cap: say how many were dropped, or a filter bug reads as
    // an employer with nothing open.
    postings_below_level: filteredOut,
    companies_deferred_to_next_run: deferred,
    postings_seen: results.reduce((n, r) => n + r.seen, 0),
    postings_closed: results.reduce((n, r) => n + r.closed, 0),
    errors: results.filter((r) => r.error).length,
    detail: results,
  };
}

function errText(e: unknown): string {
  const err = e as Error;
  return `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
}
