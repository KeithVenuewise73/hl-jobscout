// The deterministic scoring core.
//
// Stage 1 (filters.ts) kills most postings for free. Stage 2 sends the
// survivors to Claude, which scores fit 0-100 and — the part that actually
// matters — writes the angle for pitching this resume at this job.
//
// The model call is INJECTED (`ask`), so calibration, batching, cost accounting
// and the schema contract are all testable without spending a token.

import { groupDuplicates, mergedLocation, representative } from "./dedupe.ts";

export const MODEL = "claude-opus-5";

export interface Resume {
  id: number;
  label: string;
  content: string;
  must_have?: string[] | null;
  dealbreakers?: string[] | null;
  /** Walk-away number. Below this, a stated salary caps the score. */
  comp_floor?: number | null;
  /** The band actually being aimed at. Distinct from the floor on purpose: a
   *  role below target is disappointing, a role below floor is a no. */
  comp_target_low?: number | null;
  comp_target_high?: number | null;
  /** e.g. "Senior Manager / Director of Operations". */
  target_level?: string | null;
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

SENIORITY IS THE FIRST TEST. The candidate's TARGET LEVEL is stated in his
profile below. Judge the level by the SCOPE the posting actually describes —
headcount, sites, budget, who it reports to — not by the words in the title. A
"Manager" running a single DC with 80 people and a P&L can be the right level;
a "Director" who is one of forty directors under a VP often is not. A role
clearly below target level (shift supervisor, assistant manager, team lead,
coordinator, single-crew roles) caps at 30 however well the industry fits.

Then score on:
- Does his actual operating experience map to what this job runs day to day?
- Is the scope right — enough autonomy and P&L to be interesting, not so big it's
  a turnaround grind?
- Employer shape: small/single-site/private/family-owned scores higher than a
  layer deep inside a large public company.
- Compensation, using the two numbers in his profile. Below the FLOOR, cap at
  25 — that is a walk-away. Inside the TARGET BAND, treat it as a positive. \
Between floor and band, it is workable but say so in why_not. Judge only pay the
  posting actually STATES; never infer a salary from the title or the employer.
- Location. He is based in Buffalo, NY and is OPEN TO LOCATION-INDEPENDENT
  WORK: fully remote, home-based with travel, or a territory/multi-site role run
  from anywhere. At this level those are normal, and none of them is a negative.
  Judge whether the role actually requires daily presence at one site. A posting
  headed "Director, North America Logistics" carrying a Dallas address is a
  TERRITORY, not a commute — the address is where the company sits, not where
  the work happens, and it should not be marked down for that. Say so in
  why_not only when the posting genuinely demands relocation or on-site
  presence he cannot give from Buffalo. Heavy travel is acceptable; note the
  amount if the posting states it.
  When LOCATION lists SEVERAL places, the same job is open at each of them:
  judge it on the BEST one for him and name that one in why_fits.
- If the posting has no description, score on title and employer only and cap at 55.

why_not is the real risk or gap, not a hedge. resume_angle is the specific
experience to lead with in the first line of a cover letter for THIS job —
leave it empty when the verdict is pass.`;

// The API validates against this, so there is no JSON to repair on our side.
//
// NO `minimum`/`maximum` on fit_score, however tempting. Structured outputs
// accept only a subset of JSON Schema, and numeric constraints are not in it —
// the first live run came back "For 'integer' type, properties maximum, minimum
// are not supported" on every posting. (The Zod helper strips unsupported
// keywords for you; a raw schema like this one is sent verbatim.)
//
// So the range is stated in `description`, which the model does read, and
// enforced by clampScore below. The schema guarantees an integer; we guarantee
// it is an integer between 0 and 100.
export const SCHEMA = {
  type: "object",
  properties: {
    fit_score: {
      type: "integer",
      description: "Fit from 0 to 100. Most postings land near 40; a real match is rare.",
    },
    verdict: { type: "string", enum: ["apply", "maybe", "pass"] },
    why_fits: { type: "string" },
    why_not: { type: "string" },
    resume_angle: { type: "string" },
  },
  required: ["fit_score", "verdict", "why_fits", "why_not", "resume_angle"],
  additionalProperties: false,
} as const;

/** The bound the schema can no longer express. */
export const clampScore = (n: number): number =>
  Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;

/**
 * The stable prefix — byte-identical for every posting in a run, so it caches
 * and a 250-posting run pays for the resume once instead of 250 times.
 */
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export function resumePrefix(r: Resume): string {
  const band = r.comp_target_low && r.comp_target_high
    ? `${usd(r.comp_target_low)} - ${usd(r.comp_target_high)}/yr`
    : "not stated";
  return [
    "CANDIDATE RESUME",
    r.content,
    "",
    `TARGET LEVEL: ${r.target_level || "not stated"}`,
    `TARGET COMPENSATION BAND: ${band}`,
    `COMPENSATION FLOOR (walk-away): ${r.comp_floor ? usd(r.comp_floor) + "/yr" : "not stated"}`,
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

export interface ScoreRow extends Verdict {
  job_id: number;
  resume_id: number;
  model: string;
}

export interface ScoreReport {
  scored: number;
  failed: number;
  held_back_by_budget: number;
  usage: Usage;
  failures: { job_id: number; title: string; error: string }[];
  /** Copies that inherited a verdict instead of buying their own model call. */
  duplicates_collapsed: number;
  /** Set when the run stopped early because the failures were systemic. */
  aborted?: string;
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
  /** Consecutive failures that end the run. See the abort logic in runScore. */
  failFast?: number;
}

export async function runScore(deps: ScoreDeps): Promise<ScoreReport> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? 120_000;
  const limit = deps.limit ?? 250;
  const saveEvery = deps.saveEvery ?? 10;
  const failFast = deps.failFast ?? 3;
  const started = now();

  // The caller decides what deserves scoring. Stage-1 filtering lives in
  // filters.ts and runs at WRITE time, which keeps the geo gazetteer — 130KB+
  // of postal data — out of this function's deploy bundle entirely.
  // One job posted five times is one job. Group first, then take `limit` from
  // the GROUPS — otherwise a single employer's multi-store listing eats the
  // whole budget and everything behind it waits for the next run.
  const groups = groupDuplicates(deps.jobs).slice(0, limit);
  const collapsed = groups.reduce((n, g) => n + g.length - 1, 0);
  const prefix = resumePrefix(deps.resume);

  const usage: Usage = { input: 0, cached: 0, output: 0 };
  const failures: ScoreReport["failures"] = [];
  let batch: ScoreRow[] = [];
  let scored = 0;
  let processed = 0;
  let inARow = 0;
  let aborted: string | undefined;

  const flush = async () => {
    if (!batch.length) return;
    await deps.save(batch);
    batch = [];
  };

  for (const group of groups) {
    if (now() - started > budgetMs) break;
    processed++;
    const j = representative(group);
    const co = deps.companies.get(j.company_id) ?? { name: "?" };
    // The posting the model sees carries EVERY location in the group. Judging
    // one copy and copying its verdict would settle the question on whichever
    // row happened to be picked — and a Buffalo-commutable job whose Colorado
    // copy won the toss reads as a relocation.
    const merged: Job = { ...j, location: mergedLocation(group) };
    try {
      const { verdict, usage: u } = await deps.ask(prefix, postingBlock(merged, co));
      usage.input += u.input;
      usage.cached += u.cached;
      usage.output += u.output;
      const fit = clampScore(verdict.fit_score);
      // Every copy gets the verdict. They are the same job; leaving the others
      // unscored would send them back through the queue on the next run to be
      // paid for again.
      for (const member of group) {
        batch.push({
          ...verdict,
          fit_score: fit,
          job_id: member.id,
          resume_id: deps.resume.id,
          model: MODEL,
        });
      }
      scored += group.length;
      inARow = 0;
      if (batch.length >= saveEvery) await flush();
    } catch (e) {
      const err = e as Error;
      failures.push({ job_id: j.id, title: j.title, error: `${err?.name}: ${err?.message}` });

      // Some failures belong to the posting; some belong to the RUN. An empty
      // credit balance, a revoked key, a wrong model name — none of those get
      // better on the next posting, and retrying them 250 times produces 250
      // identical errors and a report nobody can read. The first live run did
      // exactly that: fifteen postings, fifteen copies of "credit balance is
      // too low".
      //
      // Rather than pattern-match on provider wording that can change, stop on
      // the SHAPE of the problem: several in a row means it is not the posting.
      // Aborting is cheap because the run resumes — anything already scored is
      // skipped next time — so the cost of stopping early is one re-run, and
      // the cost of not stopping is the whole queue.
      if (++inARow >= failFast) {
        aborted = `stopped after ${inARow} consecutive failures — ` +
          `this looks like a problem with the run, not with the postings. ` +
          `Last error: ${err?.message ?? err?.name}`;
        break;
      }
    }
  }
  await flush();

  return {
    scored,
    failed: failures.length,
    held_back_by_budget: groups.slice(processed).reduce((n, g) => n + g.length, 0),
    duplicates_collapsed: collapsed,
    usage,
    failures,
    ...(aborted ? { aborted } : {}),
  };
}
