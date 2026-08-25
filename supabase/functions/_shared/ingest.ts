// The deterministic ingest core.
//
// Every dependency — the database, the HTTP client, the clock — is injected, so
// this whole file is exercised offline by supabase/functions/tests/. The edge
// function around it (../jobscout-ingest/index.ts) only wires supabase-js to
// the Db interface below and adds nothing that can decide anything.

import { ADAPTERS, type Company, type Posting } from "./adapters.ts";
import type { FetchJson } from "./adapters.ts";

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
  /** Close this company's open jobs whose last_seen is older than `before`. Returns the count. */
  closeStale(companyId: number, before: string): Promise<number>;
  markCrawled(companyId: number, at: string): Promise<void>;
}

export interface CompanyResult {
  company: string;
  ats: string;
  seen: number;
  closed: number;
  error?: string;
}

export interface IngestReport {
  elapsed_ms: number;
  companies_crawled: number;
  companies_deferred_to_next_run: number;
  postings_seen: number;
  postings_closed: number;
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
    const rows = postings
      .filter((p) => p.ats_job_id)
      .map((p) => toRow(c.id!, p, stamp));

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
      closed = await deps.db.closeStale(c.id!, runStart);
    } catch (e) {
      results.push({ company: name, ats, seen: rows.length, closed: 0, error: `close: ${errText(e)}` });
      continue;
    }

    try {
      await deps.db.markCrawled(c.id!, stamp);
    } catch {
      // Losing the stamp only costs us a re-crawl next run. Not worth failing.
    }
    results.push({ company: name, ats, seen: rows.length, closed });
  }

  return {
    elapsed_ms: now() - started,
    companies_crawled: results.length,
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
