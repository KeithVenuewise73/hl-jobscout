// The page Keith reads. A bug here is either a job he never sees or, in the
// escaping tests below, a job posting that runs code in his browser.

import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  ago, esc, groupShortlist, renderPage, runSummary, safeUrl,
  type PageData, type ShortlistRow,
} from "../_shared/dashboard.ts";

const NOW = "2026-08-26T12:00:00Z";

const row = (o: Partial<ShortlistRow> = {}): ShortlistRow => ({
  job_id: 1, company_id: 9, fit_score: 56, verdict: "maybe",
  why_fits: "Buffalo, family-owned.", why_not: "Pay tops out below band.",
  resume_angle: "Lead with the 14-carrier network.",
  title: "Manager, Logistics", location: "Buffalo, NY",
  url: "https://example.com/job/1", comp_text: "$75,000 - $95,000 per year",
  company: "New Era Cap", source: "ats", status: null, ...o,
});

const page = (o: Partial<PageData> = {}): PageData => ({
  rows: [row()],
  runs: [{ kind: "score", ok: true, ran_at: "2026-08-26T11:00:00Z", report: { scored: 3 } }],
  coverage: {
    employers_total: 70, employers_crawlable: 10, employers_no_ats: 54,
    open_jobs: 57, sources: ["ats", "linkedin"],
  },
  now: NOW,
  ...o,
});

Deno.test("a job posting cannot run code in the browser", () => {
  // Titles, employers and the model's own prose are third-party text rendered
  // into HTML. This is the one bug here that is worse than a missing job.
  const html = renderPage(page({
    rows: [row({
      title: `<script>alert(1)</script>`,
      company: `Acme" onload="alert(2)`,
      why_fits: `<img src=x onerror=alert(3)>`,
    })],
  }));
  assertTrue(!html.includes("<script>alert(1)"), "title escaped");
  // The payload survives as visible TEXT; what must not survive is the tag.
  assertTrue(!html.includes("<img"), "no tag created from prose");
  assertStringIncludes(html, "&lt;img src=x onerror=alert(3)&gt;");
  assertTrue(!html.includes(`onload="alert(2)`), "attribute escaped");
  assertStringIncludes(html, "&lt;script&gt;alert(1)");
});

Deno.test("only http(s) links become links", () => {
  // An earlier dashboard rendered whatever was in the url column into an href.
  assertEquals(safeUrl("javascript:alert(1)"), null);
  assertEquals(safeUrl("data:text/html,<script>"), null);
  assertEquals(safeUrl(""), null);
  assertEquals(safeUrl(null), null);
  assertEquals(safeUrl("not a url"), null);
  assertTrue((safeUrl("https://x.test/j/1") ?? "").startsWith("https://"));

  const html = renderPage(page({ rows: [row({ url: "javascript:alert(1)" })] }));
  assertTrue(!html.includes("javascript:"), "no javascript href");
  assertTrue(!html.includes("Open posting"), "no dead link either");
});

Deno.test("one job posted five times is one line", () => {
  // The scorer already refuses to pay twice; the ROWS are still there. Six
  // identical lines is how a five-item shortlist starts looking like work.
  const rows = ["Littleton, CO", "Denver, CO", "Cheektowaga, NY"].map((loc, i) =>
    row({ job_id: 10 + i, title: "Warehouse Manager", location: loc, description: null })
  );
  const groups = groupShortlist(rows);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].copies, 3);
  assertStringIncludes(groups[0].location ?? "", "Cheektowaga, NY");

  const html = renderPage(page({ rows }));
  assertEquals(html.split("Warehouse Manager").length - 1, 1);
  assertStringIncludes(html, "3 listings");
});

Deno.test("an empty shortlist explains itself instead of showing nothing", () => {
  // Principle 10. A blank screen reads as broken; this says what happened.
  const html = renderPage(page({ rows: [] }));
  assertStringIncludes(html, "No open opportunities right now");
  assertStringIncludes(html, "real result, not a blank screen");
  assertStringIncludes(html, "0 live opportunities");
});

Deno.test("a machine that has never run says so rather than looking healthy", () => {
  const html = renderPage(page({ runs: [] }));
  assertStringIncludes(html, "Nothing has run yet");
  assertStringIncludes(html, "not a display problem");
});

Deno.test("a failed run is shown as failed", () => {
  const html = renderPage(page({
    runs: [{ kind: "ingest", ok: false, ran_at: "2026-08-26T11:00:00Z", report: {} }],
  }));
  assertStringIncludes(html, `class="bad"`);
  assertStringIncludes(html, "failed");
});

Deno.test("a stale run is flagged, because silence reads as success", () => {
  const html = renderPage(page({
    runs: [{ kind: "score", ok: true, ran_at: "2026-08-20T12:00:00Z", report: {} }],
  }));
  assertStringIncludes(html, "when warn");
});

Deno.test("run summaries say what actually happened", () => {
  assertStringIncludes(
    runSummary({
      kind: "ingest", ok: true, ran_at: NOW,
      report: { companies_crawled: 4, postings_seen: 13, postings_below_level: 295 },
    }),
    "295 below level",
  );
  assertStringIncludes(
    runSummary({ kind: "score", ok: true, ran_at: NOW, report: { scored: 0 } }),
    "nothing new to score",
  );
});

Deno.test("the coverage panel states what is NOT watched", () => {
  // The honest half. Someone reading a short list needs to know whether it is
  // short because nothing is open or because little is being watched.
  const html = renderPage(page());
  assertStringIncludes(html, "What this does not cover");
  assertStringIncludes(html, "<b>10</b> employers with a");
  assertStringIncludes(html, "<b>54</b> have no job board");
  assertStringIncludes(html, "loaded by hand, not automatically");
});

Deno.test("handled jobs move out of the live list but stay reachable", () => {
  const html = renderPage(page({
    rows: [row({ job_id: 1 }), row({ job_id: 2, title: "Plant Manager", status: "applied" })],
  }));
  assertStringIncludes(html, "1 live opportunity");
  assertStringIncludes(html, "1 handled");
  assertStringIncludes(html, "Plant Manager");
});

Deno.test("the page carries no key and no token", () => {
  // The browser gets data, never credentials. The token stays in the URL.
  const html = renderPage(page());
  assertTrue(!/eyJ[A-Za-z0-9_-]{10,}/.test(html), "no JWT in the page");
  assertTrue(!/service_role|anon_key|cron_token/.test(html), "no key names");
});

Deno.test("relative times read like a person wrote them", () => {
  assertEquals(ago("2026-08-26T11:59:30Z", NOW), "just now");
  assertEquals(ago("2026-08-26T11:20:00Z", NOW), "40 min ago");
  assertEquals(ago("2026-08-26T09:00:00Z", NOW), "3 hours ago");
  assertEquals(ago("2026-08-22T12:00:00Z", NOW), "4 days ago");
});

Deno.test("esc handles the characters that matter", () => {
  assertEquals(esc(`<&">'`), "&lt;&amp;&quot;&gt;&#39;");
  assertEquals(esc(null), "");
  assertEquals(esc(undefined), "");
});
