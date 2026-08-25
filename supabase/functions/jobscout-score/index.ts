// jobscout-score — reads the open postings and scores them against the resume.
//
// WIRING ONLY. Calibration, batching, the cached-prefix layout and the cost
// accounting all live in ../_shared/score.ts, exercised offline by
// ../tests/score.test.ts. This file supplies a database and a model call.
//
// Cost shape: the system prompt and the resume are sent as a cached prefix that
// is byte-identical for every posting in a run, so a 250-posting run pays for
// the resume once and reads it from cache 249 times.

import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0";
import {
  MODEL, runScore, SCHEMA, SYSTEM,
  type Ask, type Company, type Job, type Resume, type ScoreRow, type Verdict,
} from "../_shared/score.ts";

const BUDGET_MS = Number(Deno.env.get("JOBSCOUT_SCORE_BUDGET_MS") ?? 120_000);
const EFFORT = Deno.env.get("JOBSCOUT_SCORE_EFFORT") ?? "medium";
const LIMIT = Number(Deno.env.get("JOBSCOUT_SCORE_LIMIT") ?? 250);
const RESUME_LABEL = Deno.env.get("JOBSCOUT_RESUME_LABEL") ?? "keith-ops-2026";

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    // Say what is missing, and say it usefully. "Not set" sends someone to a
    // dashboard to guess; the overwhelmingly likely cause is a secret saved
    // under a near-miss name, so name the near misses that ARE present.
    //
    // Names only. A secret's value never leaves this function, and the length
    // is enough to tell a real key from an empty string or a stray quote.
    const near = Object.entries(Deno.env.toObject())
      .filter(([k]) => /ANTHROPIC|CLAUDE|_API_KEY$/i.test(k))
      .map(([k, v]) => `${k} (${v.length} chars)`)
      .sort();
    return json({
      ok: false,
      error: "ANTHROPIC_API_KEY is not set for this function",
      similar_secrets_present: near.length ? near : "none",
      fix: "Add it under Edge Functions -> Secrets for this project, named " +
        "exactly ANTHROPIC_API_KEY. Secrets are project-wide; a redeploy is " +
        "not needed, but an in-flight function keeps the old environment for " +
        "a few seconds.",
    }, 503);
  }
  const claude = new Anthropic({ apiKey });

  const { data: resumes, error: rErr } = await admin
    .from("resumes").select("*").eq("label", RESUME_LABEL).limit(1);
  if (rErr) return json({ ok: false, error: rErr.message }, 500);
  if (!resumes?.length) {
    return json({ ok: false, error: `no resume labeled '${RESUME_LABEL}' — insert one first` }, 412);
  }
  const resume = resumes[0] as Resume;

  // Already-scored postings, WITH their verdicts: a copy of a job already
  // judged inherits that verdict instead of buying another call.
  const { data: scored } = await admin
    .from("scores")
    .select("job_id,fit_score,verdict,why_fits,why_not,resume_angle")
    .eq("resume_id", resume.id);
  const verdicts = new Map(
    (scored ?? []).map((s: Record<string, unknown>) => [s.job_id as number, {
      fit_score: s.fit_score as number,
      verdict: s.verdict as Verdict["verdict"],
      why_fits: (s.why_fits ?? "") as string,
      why_not: (s.why_not ?? "") as string,
      resume_angle: (s.resume_angle ?? "") as string,
    }]),
  );
  const already = new Set(verdicts.keys());

  const { data: allJobs, error: jErr } = await admin
    .from("jobs").select("*").eq("is_open", true)
    .order("first_seen", { ascending: false }).limit(2000);
  if (jErr) return json({ ok: false, error: jErr.message }, 500);
  const open = (allJobs ?? []) as Job[];
  const jobs = open.filter((j) => !already.has(j.id));
  const known = open
    .filter((j) => already.has(j.id))
    .map((j) => ({ job: j, verdict: verdicts.get(j.id)! }));

  const { data: cos } = await admin.from("companies").select("*");
  const companies = new Map<number, Company>(
    ((cos ?? []) as Company[]).map((c) => [c.id!, c]),
  );

  const ask: Ask = async (prefix, posting) => {
    const r = await claude.messages.create({
      model: MODEL,
      // Thinking is ON BY DEFAULT on Opus 5 and its tokens count against this
      // cap. At 2000 a posting with a long description can hit the ceiling
      // mid-JSON, and a truncated response is a failed posting, not a cheap
      // one. Headroom costs nothing — billing is on tokens produced, not on
      // the cap.
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          // cache_control ends the cached prefix here. Everything before it is
          // identical across postings; everything after it is this posting.
          { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
          { type: "text", text: posting },
        ],
      }],
      // Raw JSON-schema form of structured outputs: the API validates the
      // response, so there is no JSON to repair on our side.
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: SCHEMA },
      },
      // deno-lint-ignore no-explicit-any
    } as any);

    if (r.stop_reason === "refusal") {
      throw new Error(`refused: ${r.stop_details?.category ?? "unknown"}`);
    }
    const block = r.content.find((b: { type: string }) => b.type === "text");
    if (!block) throw new Error("no text block in response");
    return {
      verdict: JSON.parse(block.text),
      usage: {
        input: (r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0),
        cached: r.usage.cache_read_input_tokens ?? 0,
        output: r.usage.output_tokens ?? 0,
      },
    };
  };

  const save = async (rows: ScoreRow[]) => {
    const { error } = await admin
      .from("scores").upsert(rows, { onConflict: "job_id,resume_id" });
    if (error) throw new Error(error.message);
  };

  try {
    const report = await runScore({
      resume, jobs, known, companies, ask, save,
      budgetMs: BUDGET_MS, limit: LIMIT,
    });
    await admin.from("runs").insert({
      kind: "score", ok: report.failed === 0, report,
    });
    return json({ ok: true, resume: resume.label, effort: EFFORT, ...report });
  } catch (e) {
    const err = e as Error;
    await admin.from("runs").insert({
      kind: "score", ok: false, report: { error: `${err.name}: ${err.message}` },
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
