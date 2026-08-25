import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  postingBlock, resumePrefix, runScore, type Ask, type Job, type Resume,
  type ScoreRow,
} from "../_shared/score.ts";
import { eligible } from "../_shared/filters.ts";

const RESUME: Resume = {
  id: 1, label: "keith-ops-2026", content: "20 years running distribution.",
  comp_floor: 75000, comp_target_low: 100000, comp_target_high: 200000,
  target_level: "Senior Manager / Director of Operations",
  dealbreakers: ["relocation required"], must_have: ["Within 50 miles of Buffalo, NY"],
};

const CO = new Map([[9, { id: 9, name: "Acme", city: "Buffalo", state: "NY", owner_type: "family", size_band: "mid" }]]);

const job = (id: number, title: string, location = "Buffalo, NY"): Job =>
  ({ id, company_id: 9, title, location, description: "Run the DC." });

const VERDICT = {
  fit_score: 72, verdict: "apply" as const, why_fits: "DC scope matches.",
  why_not: "Comp not stated.", resume_angle: "Lead with the 3PL turnaround.",
};

const okAsk: Ask = () =>
  Promise.resolve({ verdict: VERDICT, usage: { input: 500, cached: 3000, output: 120 } });

Deno.test("the prefix is byte-identical across postings — that is what makes it cache", () => {
  const a = resumePrefix(RESUME);
  const b = resumePrefix(RESUME);
  assertEquals(a, b);
  assertStringIncludes(a, "20 years running distribution.");
  assertStringIncludes(a, "$75,000/yr");
  assertStringIncludes(a, "$100,000 - $200,000/yr");
  assertStringIncludes(a, "Senior Manager / Director of Operations");
  assertStringIncludes(a, "relocation required");
});

Deno.test("the posting block carries no resume text — it must stay outside the cached prefix", () => {
  const block = postingBlock(job(1, "Operations Manager"), CO.get(9)!);
  assertEquals(block.includes(RESUME.content), false);
  assertStringIncludes(block, "Operations Manager");
  assertStringIncludes(block, "Acme");
});

Deno.test("a posting with no description says so, so the model can cap its own score", () => {
  const block = postingBlock({ id: 1, company_id: 9, title: "X", description: null }, CO.get(9)!);
  assertStringIncludes(block, "(no description available)");
});

Deno.test("stage 1 runs before any model call", () => {
  const jobs = [
    job(1, "Operations Manager"),
    job(2, "Warehouse Associate"),          // excluded by title
    job(3, "Plant Manager", "Dallas, TX"),  // excluded by location
  ];
  assertEquals(eligible(jobs).map((j) => j.id), [1]);
});

Deno.test("scores what it is given and accumulates real token usage", async () => {
  const saved: ScoreRow[][] = [];
  // The caller filters; runScore scores. eligible() is tested separately.
  const r = await runScore({
    resume: RESUME, companies: CO, ask: okAsk,
    jobs: eligible([job(1, "Operations Manager"), job(2, "Warehouse Associate")]),
    save: (rows) => { saved.push(rows); return Promise.resolve(); },
  });
  assertEquals(r.scored, 1);
  assertEquals(r.usage, { input: 500, cached: 3000, output: 120 });
  assertEquals(saved.flat().length, 1);
  assertEquals(saved.flat()[0].job_id, 1);
  assertEquals(saved.flat()[0].resume_id, 1);
  assertEquals(saved.flat()[0].fit_score, 72);
});

Deno.test("one posting failing does not lose the ones already scored", async () => {
  const saved: ScoreRow[][] = [];
  let n = 0;
  const flaky: Ask = () => {
    n++;
    if (n === 2) return Promise.reject(new Error("overloaded"));
    return Promise.resolve({ verdict: VERDICT, usage: { input: 1, cached: 0, output: 1 } });
  };
  const r = await runScore({
    resume: RESUME, companies: CO, ask: flaky,
    jobs: [job(1, "Operations Manager"), job(2, "Plant Manager"), job(3, "Fleet Manager")],
    save: (rows) => { saved.push(rows); return Promise.resolve(); },
  });
  assertEquals(r.scored, 2);
  assertEquals(r.failed, 1);
  assertEquals(saved.flat().length, 2);
  assertStringIncludes(r.failures[0].error, "overloaded");
});

Deno.test("partial results are flushed as it goes, not held to the end", async () => {
  const saved: ScoreRow[][] = [];
  await runScore({
    resume: RESUME, companies: CO, ask: okAsk,
    jobs: Array.from({ length: 5 }, (_, i) => job(i + 1, "Operations Manager")),
    saveEvery: 2,
    save: (rows) => { saved.push([...rows]); return Promise.resolve(); },
  });
  // 2 + 2 + 1 — a run that dies at posting 3 still banked the first two.
  assertEquals(saved.map((b) => b.length), [2, 2, 1]);
});

Deno.test("the wall-clock budget stops the run cleanly", async () => {
  let t = 0;
  const r = await runScore({
    resume: RESUME, companies: CO, ask: okAsk,
    jobs: Array.from({ length: 10 }, (_, i) => job(i + 1, "Operations Manager")),
    budgetMs: 100,
    now: () => (t += 60),
    save: () => Promise.resolve(),
  });
  assertTrue(r.scored < 10, "should have stopped early");
  assertTrue(r.held_back_by_budget > 0, "should report what it held back");
});

Deno.test("an unknown company does not crash the posting block", async () => {
  const r = await runScore({
    resume: RESUME, companies: new Map(), ask: okAsk,
    jobs: [job(1, "Operations Manager")],
    save: () => Promise.resolve(),
  });
  assertEquals(r.scored, 1);
});
