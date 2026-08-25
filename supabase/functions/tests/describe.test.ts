// Extraction is the whole value here: a wrong description is worse than none,
// because the scorer trusts it and stops capping at 55.

import { assertEquals, assertTrue } from "./assert.ts";
import { blockedSource, clean, extract } from "../_shared/describe.ts";

Deno.test("the job boards we deliberately do not fetch are refused", () => {
  // The alert emails exist BECAUSE these sites cannot be crawled. Every posting
  // we hold carries a linkedin.com link for Keith to click, so the guard has to
  // live in code — otherwise the obvious next step feeds those links straight
  // back into a fetcher.
  for (const u of [
    "https://www.linkedin.com/jobs/view/4447707031/",
    "https://linkedin.com/jobs/view/1",
    "https://www.indeed.com/viewjob?jk=abc",
    "https://uk.indeed.com/viewjob?jk=abc",
  ]) {
    assertTrue(blockedSource(u) !== null, u);
  }
  // Employer sites and real ATS hosts are exactly what this is for.
  for (const u of [
    "https://www.ubjobs.buffalo.edu/postings/63987",
    "https://boards.greenhouse.io/acme/jobs/1",
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=x",
  ]) {
    assertEquals(blockedSource(u), null, u);
  }
  // A lookalike domain must not slip past endsWith.
  assertEquals(blockedSource("https://notlinkedin.com/jobs/1"), null);
  assertTrue(blockedSource("not a url") !== null);
});

Deno.test("schema.org JobPosting is read in preference to the page text", () => {
  // Employers publish this for Google for Jobs. It survives redesigns that
  // break every CSS selector, and it carries pay as a NUMBER.
  const html = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Supply Chain Director",
 "description":"<p>Lead the distribution network.</p><ul><li>Own the P&amp;L for a 250,000 sq ft DC</li><li>Manage 6 direct reports and 80 hourly associates</li></ul><p>Reports to the President. Ten years of progressive operations leadership required.</p>",
 "baseSalary":{"@type":"MonetaryAmount","currency":"USD",
   "value":{"@type":"QuantitativeValue","minValue":100000,"maxValue":150000,"unitText":"YEAR"}}}
</script></head><body><nav>Home About Contact</nav></body></html>`;
  const r = extract(html);
  assertEquals(r.via, "json-ld");
  assertEquals(r.comp_text, "$100,000 - $150,000/yr");
  assertTrue(r.description!.includes("250,000 sq ft DC"));
  assertTrue(r.description!.includes("6 direct reports"));
  // Tags gone, entities decoded, nav text not swept in.
  assertTrue(!r.description!.includes("<"));
  assertTrue(r.description!.includes("P&L"));
  assertTrue(!r.description!.includes("Home About Contact"));
});

Deno.test("JobPosting is found inside an @graph or a bare array", () => {
  // Both are legal schema.org shapes and both appear on real careers pages.
  const body = `"@type":"JobPosting","description":"${"x".repeat(200)}"`;
  const graph =
    `<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{${body}}]}</script>`;
  const arr =
    `<script type="application/ld+json">[{"@type":"WebPage"},{${body}}]</script>`;
  assertEquals(extract(graph).via, "json-ld");
  assertEquals(extract(arr).via, "json-ld");
  // An @type ARRAY containing JobPosting is also legal.
  const multi =
    `<script type="application/ld+json">{"@type":["JobPosting","WebPage"],"description":"${"x".repeat(200)}"}</script>`;
  assertEquals(extract(multi).via, "json-ld");
});

Deno.test("one malformed JSON-LD block does not abandon the page", () => {
  // Real pages ship several ld+json blocks and any one may be broken.
  const html = `<script type="application/ld+json">{ this is not json </script>
<script type="application/ld+json">{"@type":"JobPosting","description":"${"y".repeat(200)}"}</script>`;
  assertEquals(extract(html).via, "json-ld");
});

Deno.test("a stub description falls through rather than being believed", () => {
  // Some boards emit JobPosting with a one-line teaser. Taking it would drop
  // the scorer's no-description cap on the strength of nothing.
  const html =
    `<script type="application/ld+json">{"@type":"JobPosting","description":"Great opportunity!"}</script>
<body>${"Real page text about the role and its responsibilities. ".repeat(20)}</body>`;
  const r = extract(html);
  assertEquals(r.via, "text");
});

Deno.test("the text fallback is marked as text, so nobody mistakes it for clean", () => {
  const html = `<html><body>${"The role runs a distribution centre. ".repeat(30)}</body></html>`;
  const r = extract(html);
  assertEquals(r.via, "text");
  assertTrue((r.description ?? "").length > 400);
});

Deno.test("a page with nothing on it reports nothing, not an empty string", () => {
  // null means "we could not read it" and keeps the scorer's 55 cap. "" would
  // read as a description that exists and is blank.
  const r = extract("<html><body><p>Loading…</p></body></html>");
  assertEquals(r.description, null);
  assertEquals(r.via, "none");
});

Deno.test("scripts and styles never reach the description", () => {
  const html = `<html><head><style>.a{color:red}</style>
<script>var jobDescription = "FAKE";</script></head>
<body>${"Genuine posting copy describing the operations role. ".repeat(20)}</body></html>`;
  const r = extract(html);
  assertTrue(!r.description!.includes("FAKE"));
  assertTrue(!r.description!.includes("color:red"));
});

Deno.test("pay is picked out of the prose when there is no baseSalary", () => {
  const mk = (s: string) =>
    `<script type="application/ld+json">{"@type":"JobPosting","description":"${s} ${"z".repeat(200)}"}</script>`;
  assertEquals(extract(mk("Salary $75,000 - $95,000 per year.")).comp_text,
    "$75,000 - $95,000 per year");
  assertEquals(extract(mk("Range is $75K-$95K a year.")).comp_text, "$75K-$95K a year");
});

Deno.test("the description is capped so one page cannot swallow a scoring run", () => {
  const html =
    `<script type="application/ld+json">{"@type":"JobPosting","description":"${"w".repeat(50_000)}"}</script>`;
  assertEquals(extract(html, 12_000).description!.length, 12_000);
});

Deno.test("clean decodes entities and collapses whitespace", () => {
  assertEquals(clean("a &amp; b"), "a & b");
  assertEquals(clean("a&#39;s"), "a's");
  assertEquals(clean("x   \n\n\n\n   y"), "x\n\ny");
});

Deno.test("page furniture is dropped before the text fallback is taken", () => {
  // Verbatim shape of what the UB careers portal actually returned: the first
  // 200 characters of the "description" were "Skip to Main Content / Toggle
  // navigation / Home / Search Jobs / Job Alerts / Log In". Nav text is not
  // neutral — the scorer reads it as part of the role.
  const html = `<html><body>
<header>Skip to Main Content Employment Opportunities</header>
<nav>Home Search Jobs Job Alerts Log In Create Account Help</nav>
<main><h1>Assistant Vice President of Operations</h1>
<p>${"Provides strategic leadership for the repair, maintenance and operations of 110 buildings across three campuses. ".repeat(6)}</p></main>
<footer>Privacy Policy Accessibility Contact Us</footer>
</body></html>`;
  const r = extract(html);
  assertEquals(r.via, "text");
  assertTrue(r.description!.startsWith("Assistant Vice President of Operations"));
  for (const junk of ["Skip to Main Content", "Search Jobs", "Log In", "Privacy Policy"]) {
    assertTrue(!r.description!.includes(junk), `leaked: ${junk}`);
  }
});

Deno.test("an empty <main> shell falls through to the body", () => {
  // Single-page apps ship <main></main> and render into it later. Trusting a
  // near-empty <main> would throw away the content that IS in the HTML.
  const html = `<html><body><main><div id="root"></div></main>
<div>${"The role runs a 250,000 square foot distribution centre. ".repeat(15)}</div>
</body></html>`;
  const r = extract(html);
  assertEquals(r.via, "text");
  assertTrue(r.description!.includes("250,000 square foot"));
});

Deno.test("JSON-LD still wins over main-content extraction", () => {
  const html = `<html><body><nav>Home Jobs</nav>
<script type="application/ld+json">{"@type":"JobPosting","description":"${"The real posting body. ".repeat(20)}"}</script>
<main>${"Some other page text entirely. ".repeat(20)}</main></body></html>`;
  const r = extract(html);
  assertEquals(r.via, "json-ld");
  assertTrue(r.description!.includes("The real posting body"));
  assertTrue(!r.description!.includes("Some other page text"));
});

Deno.test("a bare small dollar figure is not mistaken for a salary", () => {
  // Regression, and an expensive one. The loose pattern pulled "$30" off a
  // university careers page and wrote it as the posting's pay. The scorer caps
  // a job at 25 when stated pay is below the floor, so a stray "$30" turns a
  // real Director role into a rejection without anyone seeing why.
  const mk = (s: string) =>
    `<script type="application/ld+json">{"@type":"JobPosting","description":"${s} ${"z".repeat(200)}"}</script>`;
  for (const junk of [
    "Call extension $30 for details.",
    "A $25 application fee applies.",
    "Parking is $8 daily.",
  ]) {
    assertEquals(extract(mk(junk)).comp_text, null, junk);
  }
});

Deno.test("a small figure that names its unit is a salary", () => {
  // "$30 per hour" is real pay and must survive the plausibility gate.
  const mk = (s: string) =>
    `<script type="application/ld+json">{"@type":"JobPosting","description":"${s} ${"z".repeat(200)}"}</script>`;
  assertTrue((extract(mk("Pay is $30 per hour.")).comp_text ?? "").includes("30"));
  assertTrue((extract(mk("Rate: $28.50/hr")).comp_text ?? "").includes("28.50"));
  assertTrue((extract(mk("Range $22 to $30 an hour")).comp_text ?? "").includes("22"));
});

Deno.test("full salary figures still parse", () => {
  const mk = (s: string) =>
    `<script type="application/ld+json">{"@type":"JobPosting","description":"${s} ${"z".repeat(200)}"}</script>`;
  assertEquals(extract(mk("Salary $100,000 - $150,000 per year.")).comp_text,
    "$100,000 - $150,000 per year");
  assertEquals(extract(mk("Range is $75K-$95K a year.")).comp_text, "$75K-$95K a year");
  assertTrue((extract(mk("Starting at $105,000.")).comp_text ?? "").includes("105,000"));
});
