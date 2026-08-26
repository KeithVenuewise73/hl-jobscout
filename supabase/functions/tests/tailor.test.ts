import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  type Checked, correctionFor, jobBlock, numbersIn, numberSet, renderResume,
  runTailor, sanitize, type Tailored, verifyGrounded,
} from "../_shared/tailor.ts";
import type { Company, Job, Resume } from "../_shared/score.ts";

// A deliberately small resume with a few hard facts in it. Every test below
// asks the same question: can something that is NOT in here get out?
const RESUME_TEXT = `KEITH HERMAN
Operations leader, Buffalo NY.

FIVE STAR OPERATIONS — Director of Operations, 2019-2024
Managed a team of 12 across two distribution sites.
Reduced fulfilment cost per order by 18% over two years.
Owned a $4.2M operating budget.
Implemented a WMS rollout across both sites.

NIAGARA LOGISTICS — Operations Manager, 2014-2019
Ran a single warehouse with 40 staff.
Held responsibility for carrier negotiation and inbound scheduling.`;

const RESUME: Resume = { id: 1, label: "keith-ops-2026", content: RESUME_TEXT };

const JOB: Job = {
  id: 99,
  company_id: 7,
  title: "Director of Operations",
  location: "Amherst, NY",
  comp_text: "$120,000 - $140,000",
  description: "Run a regional distribution network. Kubernetes a plus.",
};

const CO: Company = { id: 7, name: "Acme Distribution", city: "Amherst", state: "NY" };

const good = (over: Partial<Tailored> = {}): Tailored => ({
  headline: "Operations leader who has run multi-site distribution.",
  bullets: [{
    text: "Led a 12-person team across two distribution sites.",
    source: "Managed a team of 12 across two distribution sites.",
    section: "FIVE STAR OPERATIONS",
  }],
  skills: ["WMS", "carrier negotiation"],
  cover_letter: "I ran two distribution sites and cut cost per order by 18%.",
  omitted: "The posting mentions Kubernetes; he has no software background.",
  ...over,
});

// ---- the fabrications this exists to catch --------------------------------

Deno.test("an invented percentage is caught", () => {
  // The canonical AI-resume failure: a number that sounds plausible and came
  // from nowhere. The resume says 18%.
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Reduced fulfilment cost per order by 31%.",
      source: "Reduced fulfilment cost per order by 18% over two years.",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "unsupported_number");
  assertStringIncludes(f[0].detail, "31");
});

Deno.test("an inflated headcount is caught even with an honest source quote", () => {
  // The source is real, which is exactly how this slips through a human read:
  // the citation checks out and the number still changed.
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Led a 30-person team across two distribution sites.",
      source: "Managed a team of 12 across two distribution sites.",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "unsupported_number");
});

Deno.test("a paraphrased source quote is caught", () => {
  // If the quote is not verbatim, nothing anchors the bullet to the resume,
  // so the bullet cannot be trusted however true it looks.
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Led a 12-person team.",
      source: "Managed a team of twelve people at two sites.",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "source_not_in_resume");
});

Deno.test("a real number attached to an invented subject is caught", () => {
  // The hole the first live run exposed. Both numbers below are genuinely in
  // the resume — 12 people, 18 percent — but on different lines, describing
  // different things. Checked against the whole document this verifies clean:
  // right digits, invented claim. Checked against the line the bullet itself
  // cites, it does not.
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Cut fulfilment cost per order by 12%.",
      source: "Reduced fulfilment cost per order by 18% over two years.",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "unsupported_number");
  assertStringIncludes(f[0].detail, "cites");
});

Deno.test("a number from the line the bullet cites is accepted", () => {
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Owned a $4.2M operating budget.",
      source: "Owned a $4.2M operating budget.",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f, []);
});

Deno.test("an invented figure in the cover letter is caught", () => {
  const f = verifyGrounded(RESUME_TEXT, good({
    cover_letter: "In my last role I ran 6 distribution centres.",
  }));
  assertTrue(f.some((x) => x.where === -1 && x.detail.includes("6")));
});

Deno.test("an invented figure in the headline is caught", () => {
  const f = verifyGrounded(RESUME_TEXT, good({
    headline: "Operations leader with 25 years running distribution networks.",
  }));
  assertTrue(f.some((x) => x.where === -1 && x.detail.includes("25")));
});

// ---- and the true statements it must NOT reject ---------------------------

Deno.test("an honest rewrite passes", () => {
  assertEquals(verifyGrounded(RESUME_TEXT, good()), []);
});

Deno.test("rewording a number into words is not a fabrication", () => {
  // "a team of twelve" and "a team of 12" are the same claim. Rejecting this
  // would send him back to editing by hand, which is the thing being removed.
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Led a team of twelve across two distribution sites.",
      source: "Managed a team of 12 across two distribution sites.",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f, []);
});

Deno.test("the same money written a different way is not a fabrication", () => {
  // "$4.2M" in the resume and "$4.2 million" in the rewrite are one claim.
  const f = verifyGrounded(RESUME_TEXT, good({
    cover_letter: "I owned a $4.2 million operating budget.",
  }));
  assertEquals(f, []);
});

Deno.test("a dollar figure is not vouched for by a headcount sharing its digits", () => {
  // The regression that made this check worth writing. The resume says "a team
  // of 12"; it says nothing about twelve million dollars. Canonicalising
  // "$12M" down to "12" made the second verify clean against the first.
  const f = verifyGrounded(RESUME_TEXT, good({
    cover_letter: "In my last role I managed a $12M budget.",
  }));
  assertEquals(f.length, 1);
  assertStringIncludes(f[0].detail, "12000000");
});

Deno.test("a percentage is not vouched for by a bare number sharing its digits", () => {
  // The resume states 40 staff. It does not state 40 percent of anything.
  const f = verifyGrounded(RESUME_TEXT, good({
    cover_letter: "I cut fulfilment cost by 40%.",
  }));
  assertEquals(f.length, 1);
  assertStringIncludes(f[0].detail, "40%");
});

Deno.test("percent written as a word is the same claim as the symbol", () => {
  const f = verifyGrounded(RESUME_TEXT, good({
    cover_letter: "I reduced fulfilment cost per order by 18 percent.",
  }));
  assertEquals(f, []);
});

Deno.test("a magnitude suffix expands to the figure it means", () => {
  const set = numberSet("Owned a $450K budget.");
  assertTrue(set.has("450000"), "$450K is a claim about 450,000");
  assertTrue(!set.has("450"), "and NOT a claim about the number 450");
});

Deno.test("case and punctuation do not break a verbatim quote", () => {
  const f = verifyGrounded(RESUME_TEXT, good({
    bullets: [{
      text: "Rolled out a WMS across both sites.",
      source: "implemented a wms rollout across both sites",
      section: "FIVE STAR OPERATIONS",
    }],
  }));
  assertEquals(f, []);
});

// ---- what happens to a failure --------------------------------------------

Deno.test("a failed bullet is removed and reported, never silently kept", () => {
  const t = good({
    bullets: [
      good().bullets[0],
      {
        text: "Cut costs by 62%.",
        source: "Reduced fulfilment cost per order by 18% over two years.",
        section: "FIVE STAR OPERATIONS",
      },
    ],
  });
  const c = sanitize(RESUME_TEXT, t);
  assertEquals(c.clean.bullets.length, 1);
  assertEquals(c.clean.bullets[0].text, "Led a 12-person team across two distribution sites.");
  assertEquals(c.removed.length, 1);
  assertStringIncludes(c.removed[0].why, "62");
});

Deno.test("a bad letter is reported rather than deleted", () => {
  // A bullet can be cut and the document is still whole. A sentence cut out of
  // a letter leaves a hole, so this has to come back to the caller.
  const c = sanitize(RESUME_TEXT, good({
    cover_letter: "I managed 300 people.",
  }));
  assertEquals(c.clean.bullets.length, 1);
  assertEquals(c.document.length, 1);
  assertEquals(c.removed.length, 0);
});

Deno.test("the correction names the specific invented figure", () => {
  // A vague "please be accurate" retry is worth nothing; the model has to be
  // told which claim was wrong.
  const c = sanitize(RESUME_TEXT, good({
    bullets: [{
      text: "Cut costs by 62%.",
      source: "Reduced fulfilment cost per order by 18% over two years.",
      section: "X",
    }],
  }));
  assertStringIncludes(correctionFor(c), "62");
});

// ---- the run --------------------------------------------------------------

const usage = { input: 10, cached: 0, output: 5 };

Deno.test("a clean first attempt is not paid for twice", async () => {
  let calls = 0;
  const { report } = await runTailor({
    resume: RESUME, job: JOB, company: CO,
    ask: () => {
      calls++;
      return Promise.resolve({ tailored: good(), usage });
    },
  });
  assertEquals(calls, 1);
  assertEquals(report.retried, false);
  assertEquals(report.ok, true);
  assertEquals(report.usage.output, 5);
});

Deno.test("an invented figure buys exactly one retry", async () => {
  let calls = 0;
  const { result, report } = await runTailor({
    resume: RESUME, job: JOB, company: CO,
    ask: (_r, _p, correction) => {
      calls++;
      // Second call must be told what was wrong.
      if (calls === 2) assertStringIncludes(correction ?? "", "99");
      return Promise.resolve({
        tailored: calls === 1
          ? good({ cover_letter: "I saved 99% of costs." })
          : good(),
        usage,
      });
    },
  });
  assertEquals(calls, 2);
  assertEquals(report.retried, true);
  assertEquals(report.ok, true);
  assertEquals(result.document.length, 0);
  // A clean retry must not erase the record of what the first try reached for.
  assertTrue(report.first_attempt_rejected?.some((r) => r.includes("99")));
  // Both calls are billed, and the report says so.
  assertEquals(report.usage.output, 10);
});

Deno.test("a model that keeps inventing does not loop forever", async () => {
  let calls = 0;
  const { report } = await runTailor({
    resume: RESUME, job: JOB, company: CO,
    ask: () => {
      calls++;
      return Promise.resolve({
        tailored: good({ cover_letter: "I saved 99% of costs." }),
        usage,
      });
    },
  });
  assertEquals(calls, 2);
  assertEquals(report.ok, false);
  assertTrue(report.document_findings.length > 0);
});

Deno.test("a worse second attempt is discarded", async () => {
  // Later is not the same as better. If the retry invents more, keep the first.
  let calls = 0;
  const { result } = await runTailor({
    resume: RESUME, job: JOB, company: CO,
    ask: () => {
      calls++;
      return Promise.resolve({
        tailored: calls === 1
          ? good({ cover_letter: "I saved 99% of costs." })
          : good({
            cover_letter: "I saved 99% of costs.",
            headline: "Leader of 500 people.",
          }),
        usage,
      });
    },
  });
  assertEquals(result.clean.headline, "Operations leader who has run multi-site distribution.");
});

// ---- what he actually receives --------------------------------------------

Deno.test("the resume renders as plain single-column text", () => {
  const out = renderResume(RESUME, good(), JOB, CO);
  assertStringIncludes(out, "Director of Operations");
  assertStringIncludes(out, "SUMMARY");
  assertStringIncludes(out, "- Led a 12-person team");
  // Nothing an applicant tracking parser chokes on.
  assertTrue(!/[|<>]/.test(out), "no table or markup characters");
});

Deno.test("the posting block passes the angle the scorer already paid for", () => {
  const block = jobBlock(JOB, CO, {
    fit_score: 60, verdict: "apply",
    why_fits: "", why_not: "",
    resume_angle: "Lead with the two-site WMS rollout.",
  });
  assertStringIncludes(block, "two-site WMS rollout");
});

Deno.test("a posting with no description says so rather than sending an empty field", () => {
  assertStringIncludes(jobBlock({ ...JOB, description: null }, CO), "no description available");
});
