import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  clampScore, postingBlock, resumePrefix, runScore, SCHEMA, SYSTEM,
  type Ask, type Job, type Resume, type ScoreRow,
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
    // Distinct titles: five copies of one title at one employer are one job
    // now, and this test is about flushing, not about deduplication.
    jobs: Array.from({ length: 5 }, (_, i) => job(i + 1, `Operations Manager ${i}`)),
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
    jobs: Array.from({ length: 10 }, (_, i) => job(i + 1, `Operations Manager ${i}`)),
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

Deno.test("a systemic failure stops the run instead of repeating itself", () => {
  // Regression from the first live run: an empty Anthropic credit balance
  // produced fifteen postings' worth of the identical 400. That error belongs
  // to the run, not to any posting, and hammering the whole queue with it wastes
  // calls and buries the real message in a wall of duplicates.
  return (async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1, company_id: 1, title: `Operations Manager ${i}`,
    }));
    let calls = 0;
    const report = await runScore({
      resume: RESUME,
      jobs,
      companies: new Map([[1, { id: 1, name: "Acme" }]]),
      ask: () => {
        calls++;
        return Promise.reject(new Error("400 credit balance is too low"));
      },
      save: () => Promise.resolve(),
    });
    assertEquals(calls, 3);
    assertEquals(report.scored, 0);
    assertEquals(report.failed, 3);
    assertTrue((report.aborted ?? "").includes("credit balance"));
    // The 17 it never reached are reported, not silently forgotten.
    assertEquals(report.held_back_by_budget, 17);
  })();
});

Deno.test("an isolated failure does not stop the run", () => {
  // The counter has to RESET on success, or three scattered bad postings in a
  // long queue would abort a run that is working perfectly well.
  return (async () => {
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, company_id: 1, title: `Operations Manager ${i}`,
    }));
    const report = await runScore({
      resume: RESUME,
      jobs,
      companies: new Map([[1, { id: 1, name: "Acme" }]]),
      // Fail every other posting: never three in a row.
      ask: (_p, posting) =>
        /[135]/.test(posting.match(/Manager (\d)/)?.[1] ?? "")
          ? Promise.reject(new Error("posting-specific boom"))
          : Promise.resolve({
            verdict: {
              fit_score: 50, verdict: "maybe" as const,
              why_fits: "x", why_not: "y", resume_angle: "z",
            },
            usage: { input: 10, cached: 0, output: 5 },
          }),
      save: () => Promise.resolve(),
    });
    assertEquals(report.scored, 3);
    assertEquals(report.failed, 3);
    assertEquals(report.aborted, undefined);
    assertEquals(report.held_back_by_budget, 0);
  })();
});

Deno.test("the schema uses no keyword structured outputs rejects", () => {
  // The first live run failed on every posting with "For 'integer' type,
  // properties maximum, minimum are not supported". Structured outputs accept
  // a subset of JSON Schema; numeric and string constraints are not in it, and
  // a raw schema (unlike the Zod helper) is sent to the API verbatim.
  const banned = ["minimum", "maximum", "multipleOf", "minLength", "maxLength",
                  "minItems", "maxItems", "pattern"];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      assertEquals(banned.includes(k), false, `${path}.${k} is not supported`);
      walk(v, `${path}.${k}`);
    }
  };
  walk(SCHEMA, "SCHEMA");
  // additionalProperties:false is REQUIRED, so assert it did not get lost.
  assertEquals(SCHEMA.additionalProperties, false);
});

Deno.test("the score range is enforced in code, since the schema cannot", () => {
  assertEquals(clampScore(150), 100);
  assertEquals(clampScore(-20), 0);
  assertEquals(clampScore(72.6), 73);
  assertEquals(clampScore(NaN), 0);
  assertEquals(clampScore(55), 55);
});

Deno.test("an out-of-range score is clamped before it reaches the database", () => {
  // fit_score is a plain int column feeding a `order by fit_score desc` view.
  // A 150 would sort above every real result and quietly top the shortlist.
  return (async () => {
    let saved: ScoreRow[] = [];
    await runScore({
      resume: RESUME,
      jobs: [{ id: 1, company_id: 1, title: "Operations Director" }],
      companies: new Map([[1, { id: 1, name: "Acme" }]]),
      ask: () =>
        Promise.resolve({
          verdict: {
            fit_score: 150, verdict: "apply" as const,
            why_fits: "x", why_not: "y", resume_angle: "z",
          },
          usage: { input: 10, cached: 0, output: 5 },
        }),
      save: (rows) => {
        saved = saved.concat(rows);
        return Promise.resolve();
      },
    });
    assertEquals(saved.length, 1);
    assertEquals(saved[0].fit_score, 100);
  })();
});

Deno.test("the scorer is told that a distant address on a territory role is not a fault", () => {
  // The gate and the prompt have to move together. Admitting national and
  // remote postings while the prompt still reads location as a commute just
  // produces a longer list of low scores — worse than not admitting them,
  // because it looks like the model considered them and said no.
  assertStringIncludes(SYSTEM, "LOCATION-INDEPENDENT");
  assertStringIncludes(SYSTEM, "TERRITORY, not a commute");
  assertStringIncludes(SYSTEM, "Heavy travel is acceptable");
  // Deduplication hands the model one posting carrying every location the job
  // was found in. Without this line it has no instruction on what to do with a
  // list, and may average them or take the first.
  assertStringIncludes(SYSTEM, "judge it on the BEST one for him");
});

Deno.test("one job posted five times buys one model call, not five", () => {
  // The Tile Shop's "Warehouse Manager" ran to six rows across five stores and
  // was scored six times. Every copy is a model call and a duplicate line on
  // the shortlist for a job already judged.
  return (async () => {
    let calls = 0;
    const saved: ScoreRow[] = [];
    const report = await runScore({
      resume: RESUME,
      companies: CO,
      jobs: [
        job(1, "Warehouse Manager", "Littleton, CO"),
        job(2, "Warehouse Manager", "Cheektowaga, NY"),
        job(3, "Warehouse Manager", "Avon, MA"),
        job(4, "Operations Director", "Buffalo, NY"),
      ],
      ask: (_p, posting) => {
        calls++;
        // Every location reaches the model in ONE posting, so it can see that
        // one of the stores is in range.
        assertStringIncludes(posting, "LOCATION:");
        return Promise.resolve({ verdict: VERDICT, usage: { input: 1, cached: 0, output: 1 } });
      },
      save: (rows) => {
        saved.push(...rows);
        return Promise.resolve();
      },
    });

    assertEquals(calls, 2);                    // two real jobs, two calls
    assertEquals(report.duplicates_collapsed, 2);
    // Every copy still gets a score, so none returns to the queue next run.
    assertEquals(saved.length, 4);
    assertEquals(saved.map((r) => r.job_id).sort(), [1, 2, 3, 4]);
    assertEquals(new Set(saved.map((r) => r.fit_score)).size, 1);
  })();
});

Deno.test("the grouped posting names every location it was found in", () => {
  return (async () => {
    let seen = "";
    await runScore({
      resume: RESUME,
      companies: CO,
      jobs: [
        job(1, "Warehouse Manager", "Littleton, CO"),
        job(2, "Warehouse Manager", "Cheektowaga, NY"),
      ],
      ask: (_p, posting) => {
        seen = posting;
        return Promise.resolve({ verdict: VERDICT, usage: { input: 1, cached: 0, output: 1 } });
      },
      save: () => Promise.resolve(),
    });
    assertStringIncludes(seen, "Cheektowaga, NY");
    assertStringIncludes(seen, "Littleton, CO");
    assertStringIncludes(seen, "(2 locations)");
  })();
});

Deno.test("the limit counts JOBS, not copies", () => {
  // Taking `limit` from the raw rows would let one employer's multi-store
  // listing eat the whole budget while real jobs behind it wait a full run.
  return (async () => {
    let calls = 0;
    const report = await runScore({
      resume: RESUME,
      companies: CO,
      jobs: [
        job(1, "Warehouse Manager", "A"), job(2, "Warehouse Manager", "B"),
        job(3, "Warehouse Manager", "C"), job(4, "Warehouse Manager", "D"),
        job(5, "Operations Director", "Buffalo, NY"),
      ],
      limit: 2,
      ask: () => {
        calls++;
        return Promise.resolve({ verdict: VERDICT, usage: { input: 1, cached: 0, output: 1 } });
      },
      save: () => Promise.resolve(),
    });
    assertEquals(calls, 2);
    assertEquals(report.scored, 5); // 4 copies + 1 — the Director was reached
  })();
});
