// Alert-email parsing, against real emails from Keith's inbox (fixtures with
// the personalised tracking tokens stripped).

import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  parseAlert, parseIndeedAlert, parseLinkedInAlert, stableId,
} from "../_shared/alerts.ts";
import { INDEED_DIGEST, LINKEDIN_DIGEST } from "./fixtures/alerts.ts";

Deno.test("indeed: every posting in the digest is found", () => {
  const rows = parseIndeedAlert(INDEED_DIGEST);
  assertEquals(rows.length, 5);
  assertEquals(rows.map((r) => r.title), [
    "Operations Supervisor",
    "Operations Manager",
    "Facility Operations Manager",
    "Sr Platform Operations Manager",
    "Operations Manager",
  ]);
});

Deno.test("indeed: company and location split on the ' - ' line", () => {
  const [first] = parseIndeedAlert(INDEED_DIGEST);
  assertEquals(first.company, "Ryerson");
  assertEquals(first.location, "Lancaster, NY");
});

Deno.test("indeed: a company name containing a comma survives", () => {
  const r = parseIndeedAlert(INDEED_DIGEST).find((x) => x.company.startsWith("U.S."));
  assertEquals(r?.company, "U.S. Facilities, Inc");
  assertEquals(r?.location, "New York State");
});

Deno.test("indeed: salary carries its provenance", () => {
  // Indeed's own footer says salaries are estimated when the posting omits one,
  // and the scorer is told to judge only STATED pay. So the caveat travels with
  // the number instead of being silently dropped.
  const [first] = parseIndeedAlert(INDEED_DIGEST);
  assertStringIncludes(first.comp_text!, "$64,855.53 - $97,283.29 a year");
  assertStringIncludes(first.comp_text!, "may be an Indeed estimate");
});

Deno.test("indeed: badge lines are not mistaken for the description", () => {
  const r = parseIndeedAlert(INDEED_DIGEST)[1];
  // "Responsive employer" and "Easily apply" sit between the pay and the snippet.
  assertStringIncludes(r.description!, "Operational Excellence");
  assertEquals(r.description!.includes("Easily apply"), false);
  assertEquals(r.posted_hint, "7 days ago");
});

Deno.test("indeed: ids are derived, because the ones in the email are corrupt", () => {
  // Plaintext eats the "=" in the query string, so jk= arrives damaged
  // ("jkK3d58141c0f9b1f"). Deriving from title+company+location gives an id
  // that is stable across re-sends instead of one that is merely present.
  const a = parseIndeedAlert(INDEED_DIGEST);
  const b = parseIndeedAlert(INDEED_DIGEST);
  assertEquals(a.map((r) => r.ats_job_id), b.map((r) => r.ats_job_id));
  assertEquals(new Set(a.map((r) => r.ats_job_id)).size, a.length, "no collisions");
  // Same title at a different employer must not collide.
  assertTrue(a[1].ats_job_id !== a[4].ats_job_id, "Operations Manager x2, different cos");
});

Deno.test("linkedin: every posting is found, split on the dashed rule", () => {
  const rows = parseLinkedInAlert(LINKEDIN_DIGEST);
  assertEquals(rows.length, 4);
  assertEquals(rows[0].title, "Plant Manager");
  assertEquals(rows[0].company, "GTI Fabrication");
  assertEquals(rows[0].location, "Buffalo, NY");
});

Deno.test("linkedin: uses LinkedIn's own job id from the URL path", () => {
  // The path id is clean even though the query string is mangled.
  assertEquals(parseLinkedInAlert(LINKEDIN_DIGEST).map((r) => r.ats_job_id), [
    "li-4422048854", "li-4456823450", "li-4455838453", "li-4430972099",
  ]);
});

Deno.test("linkedin: badges are not read as the company or location", () => {
  const rows = parseLinkedInAlert(LINKEDIN_DIGEST);
  // "Fast growing", "12 school alumni", "This company is actively hiring" and
  // "Apply with resume & profile" all sit inside the posting block.
  assertEquals(rows[1].company, "Regal");
  assertEquals(rows[2].company, "Domino's");
  assertEquals(rows[3].company, "The Tile Shop");
  assertEquals(rows[3].location, "Cheektowaga, NY");
});

Deno.test("linkedin: the footer and 'See all jobs' block are not postings", () => {
  const rows = parseLinkedInAlert(LINKEDIN_DIGEST);
  assertEquals(rows.some((r) => /See all jobs|LinkedIn Corporation/.test(r.title)), false);
});

Deno.test("parseAlert routes on sender and refuses to guess", () => {
  assertEquals(parseAlert("donotreply@jobalert.indeed.com", INDEED_DIGEST).length, 5);
  assertEquals(parseAlert("jobalerts-noreply@linkedin.com", LINKEDIN_DIGEST).length, 4);
  assertEquals(parseAlert("recruiter@example.com", INDEED_DIGEST).length, 0);
});

Deno.test("garbage in does not throw", () => {
  for (const junk of ["", "hello", "\n\n\n", "https://www.indeed.com/rc/clk/dl?x"]) {
    assertEquals(Array.isArray(parseIndeedAlert(junk)), true);
    assertEquals(Array.isArray(parseLinkedInAlert(junk)), true);
  }
});

Deno.test("stableId is deterministic and case-insensitive", () => {
  assertEquals(stableId("in", "Ops Manager", "Acme"), stableId("in", "ops manager", "acme"));
  assertTrue(stableId("in", "A", "B") !== stableId("in", "A", "C"));
});
