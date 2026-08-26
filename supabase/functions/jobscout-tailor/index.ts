// jobscout-tailor — rewrite the resume for one posting, and draft the letter.
//
// WIRING ONLY. The prompt contract, the anti-fabrication check, the retry and
// the rendering all live in ../_shared/tailor.ts and are exercised offline by
// ../tests/tailor.test.ts without spending a token.
//
// Called from the shortlist page with the view token, one job at a time — this
// is not on the schedule. Tailoring every posting would be paying to write
// applications he was never going to send.
//
// Cost shape: the resume is the cached prefix, so tailoring the second job of
// a session reads it from cache instead of paying for it again.

import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0";
import { tokenMatches } from "../_shared/auth.ts";
import type { Company, Job, Resume, Verdict } from "../_shared/score.ts";
import {
  MODEL, renderResume, runTailor, SCHEMA, SYSTEM,
  type AskTailor, type Tailored,
} from "../_shared/tailor.ts";

const EFFORT = Deno.env.get("JOBSCOUT_TAILOR_EFFORT") ?? "high";
const RESUME_LABEL = Deno.env.get("JOBSCOUT_RESUME_LABEL") ?? "keith-ops-2026";

Deno.serve(async (req) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  const { data: rt, error: rtErr } = await admin
    .from("runtime").select("view_token").limit(1);
  if (rtErr) return json({ ok: false, error: rtErr.message }, 500);
  const view = (rt as { view_token?: string }[] | null)?.[0]?.view_token ?? null;
  if (!view) return json({ ok: false, error: "no view token configured" }, 503);
  if (!tokenMatches(new URL(req.url).searchParams.get("k"), view)) {
    return json({ ok: false, error: "not found" }, 404);
  }

  let body: { job_id?: number };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "expected JSON" }, 400);
  }
  const jobId = Number(body.job_id);
  if (!Number.isInteger(jobId)) {
    return json({ ok: false, error: "job_id is required" }, 400);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ ok: false, error: "ANTHROPIC_API_KEY is not set for this function" }, 503);
  }
  const claude = new Anthropic({ apiKey });

  const [jobs, resumes] = await Promise.all([
    admin.from("jobs").select("*").eq("id", jobId).limit(1),
    admin.from("resumes").select("*").eq("label", RESUME_LABEL).limit(1),
  ]);
  if (!jobs.data?.length) return json({ ok: false, error: `no job ${jobId}` }, 404);
  if (!resumes.data?.length) {
    return json({ ok: false, error: `no resume labeled '${RESUME_LABEL}'` }, 412);
  }
  const job = jobs.data[0] as Job;
  const resume = resumes.data[0] as Resume;

  const [cos, scores] = await Promise.all([
    admin.from("companies").select("*").eq("id", job.company_id).limit(1),
    // The scorer already read this posting against this resume and wrote the
    // angle to lead with. Passing it through means not paying to think it out
    // a second time.
    admin.from("scores").select("*")
      .eq("job_id", jobId).eq("resume_id", resume.id).limit(1),
  ]);
  const company = (cos.data?.[0] ?? { name: "?" }) as Company;
  const verdict = scores.data?.[0] as Verdict | undefined;

  const ask: AskTailor = async (prefix, posting, correction) => {
    const content: Record<string, unknown>[] = [
      // The resume is byte-identical across every job he tailors for, so it
      // caches. The posting after it is what varies.
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
      { type: "text", text: posting },
    ];
    // The correction goes LAST, after the cache breakpoint, so a retry still
    // reads the resume from cache rather than paying for it twice.
    if (correction) content.push({ type: "text", text: correction });

    const r = await claude.messages.create({
      model: MODEL,
      // Thinking is on by default on Opus 5 and its tokens count against this
      // cap. A full resume plus a letter is a long output; a truncated one is
      // a failed tailoring, not a cheap one.
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
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
      tailored: JSON.parse(block.text) as Tailored,
      usage: {
        input: (r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0),
        cached: r.usage.cache_read_input_tokens ?? 0,
        output: r.usage.output_tokens ?? 0,
      },
    };
  };

  try {
    const { result, report } = await runTailor({
      resume, job, company, verdict, ask,
    });
    const text = renderResume(resume, result.clean, job, company);

    const { error } = await admin.from("tailorings").upsert({
      job_id: jobId,
      resume_id: resume.id,
      headline: result.clean.headline,
      bullets: result.clean.bullets,
      skills: result.clean.skills,
      cover_letter: result.clean.cover_letter,
      omitted: result.clean.omitted,
      resume_text: text,
      // `verified` is the whole promise. It is false whenever anything in the
      // finished document could not be traced back to the resume.
      verified: report.ok && report.bullets_removed.length === 0,
      report,
      model: MODEL,
    }, { onConflict: "job_id,resume_id" });
    if (error) throw new Error(error.message);

    await admin.from("runs").insert({
      kind: "tailor", ok: report.ok, report: { job_id: jobId, ...report },
    });
    return json({ ok: true, job_id: jobId, ...report });
  } catch (e) {
    const err = e as Error;
    await admin.from("runs").insert({
      kind: "tailor", ok: false,
      report: { job_id: jobId, error: `${err.name}: ${err.message}` },
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
