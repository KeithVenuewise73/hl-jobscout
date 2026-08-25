// The deterministic scoring core.
//
// Stage 1 (filters.ts) kills most postings for free. Stage 2 sends the
// survivors to Claude, which scores fit 0-100 and — the part that actually
// matters — writes the angle for pitching this resume at this job.
//
// The model call is INJECTED (`ask`), so calibration, batching, cost accounting
// and the schema contract are all testable without spending a token.

import { locationOk, titleOk } from "./filters.ts";

export const MODEL = "claude-opus-5";

export interface Resume {
  id: number;
  label: string;
  content: string;
  must_have?: string[] | null;
  dealbreakers?: string[] | null;
  comp_floor?: number | null;
}

export interface Job {
  id: number;
  company_id: number;
  title: string;
  location?: string | null;
  comp_text?: string | null;
  description?: string | null;
}

export interface Company {
  id?: number;
  name?: string;
  city?: string | null;
  state?: string | null;
  owner_type?: string | null;
  size_band?: string | null;
}

export interface Verdict {
  fit_score: number;
  verdict: "apply" | "maybe" | "pass";
  why_fits: string;
  why_not: string;
  resume_angle: string;
}

export interface Usage {
  input: number;
  cached: number;
  output: number;
}

/** Injected model call: takes the cached prefix and the posting, returns a verdict. */
export type Ask = (prefix: string, posting: string) => Promise<{ verdict: Verdict; usage: Usage }>;

export const SYSTEM = `You screen job postings for one specific candidate. You are blunt and \
calibrated — most postings are a 40, a real match is rare. Inflated scores make \
the tool useless.

Score on:
- Does his actual operating experience map to what this job runs day to day?
- Is the scope right — enough autonomy and P&L to be interesting, not so big it's
  a turnaround grind?
- Employer shape: small/single-site/private/family-owned scores higher than a
  layer deep inside a large public company.
- Compensation: if the posting states pay below his floor, cap the score at 25.
- If the posting has no description, score on title and employer only and cap at 55.

why_not is the real risk or gap, not a hedge. resume_angle is the specific
experience to lead with in the first line of a cover letter for THIS job —
leave it empty when the verdict is pass.`;

// The API validates against this, so there is no JSON to repair on our side.
export const SCHEMA = {
  type: "object",
  properties: {
    fit_score: { type: "integer", minimum: 0, maximum: 100 },
    verdict: { type: "string", enum: ["apply", "maybe", "pass"] },
    why_fits: { type: "string" },
    why_not: { type: "string" },
    resume_angle: { type: "string" },
  },
  required: ["fit_score", "verdict", "why_fits", "why_not", "resume_angle"],
  additionalProperties: false,
} as const;

/**
 * The stable prefix — byte-identical for every posting in a run, so it caches
 * and a 250-posting run pays for the resume once instead of 250 times.
 */
export function resumePrefix(r: Resume): string {
  const floor = r.comp_floor ?? 0;
  return [
    "CANDIDATE RESUME",
    r.content,
    "",
    `COMPENSATION FLOOR: $${floor.toLocaleString("en-US")}/yr`,
    `MUST HAVE: ${(r.must_have ?? []).join(", ") || "none stated"}`,
    `DEALBREAKERS: ${(r.dealbreakers ?? []).join(", ") || "none stated"}`,
  ].join("\n");
}

export function postingBlock(job: Job, co: Company): string {
  return [
    "---",
    `EMPLOYER: ${co.name ?? "?"} | ${co.city ?? "?"}, ${co.state ?? ""} | ` +
    `${co.owner_type ?? "unknown ownership"} | ${co.size_band ?? "unknown size"}`,
    "",
    `POSTING TITLE: ${job.title}`,
    `LOCATION: ${job.location || "not stated"}`,
    `STATED PAY: ${job.comp_text || "not stated"}`,
    "",
    "DESCRIPTION:",
    job.description || "(no description available)",
  ].join("\n");
}

/** Stage 1. Free, and the reason the model bill stays small. */
export function eligible(jobs: Job[]): Job[] {
  return jobs.filter((j) => titleOk(j.title) && locationOk(j.location));
}

export interface ScoreRow extends Verdict {
  job_id: number;
  resume_id: number;
  model: string;
}

export interface ScoreReport {
  scored: number;
  failed: number;
  filtered_out_free: number;
  held_back_by_budget: number;
  usage: Usage;
  failures: { job_id: number; title: string; error: string }[];
}

export interface ScoreDeps {
  resume: Resume;
  jobs: Job[];
  companies: Map<number, Company>;
  ask: Ask;
  save: (rows: ScoreRow[]) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  limit?: number;
  saveEvery?: number;
}

export async function runScore(deps: ScoreDeps): Promise<ScoreReport> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? 120_000;
  const limit = deps.limit ?? 250;
  const saveEvery = deps.saveEvery ?? 10;
  const started = now();

  const survivors = eligible(deps.jobs);
  const queue = survivors.slice(0, limit);
  const prefix = resumePrefix(deps.resume);

  const usage: Usage = { input: 0, cached: 0, output: 0 };
  const failures: ScoreReport["failures"] = [];
  let batch: ScoreRow[] = [];
  let scored = 0;
  let processed = 0;

  const flush = async () => {
    if (!batch.length) return;
    await deps.save(batch);
    batch = [];
  };

  for (const j of queue) {
    if (now() - started > budgetMs) break;
    processed++;
    const co = deps.companies.get(j.company_id) ?? { name: "?" };
    try {
      const { verdict, usage: u } = await deps.ask(prefix, postingBlock(j, co));
      usage.input += u.input;
      usage.cached += u.cached;
      usage.output += u.output;
      batch.push({ ...verdict, job_id: j.id, resume_id: deps.resume.id, model: MODEL });
      scored++;
      if (batch.length >= saveEvery) await flush();
    } catch (e) {
      const err = e as Error;
      failures.push({ job_id: j.id, title: j.title, error: `${err?.name}: ${err?.message}` });
    }
  }
  await flush();

  return {
    scored,
    failed: failures.length,
    filtered_out_free: deps.jobs.length - survivors.length,
    held_back_by_budget: queue.length - processed + (survivors.length - queue.length),
    usage,
    failures,
  };
}
