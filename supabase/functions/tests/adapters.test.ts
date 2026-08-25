// Adapter parsing — recorded ATS payloads, no network.
//
// These prove the field mapping, not the live boards. A board that changes its
// JSON shape will still break ingest and these will still pass; only a real
// crawl catches that.

import { assertEquals, assertStringIncludes } from "./assert.ts";
import {
  fetchAshby, fetchGreenhouse, fetchLever, fetchSmartRecruiters, fetchWorkday,
  iso, stripHtml,
} from "../_shared/adapters.ts";
import type { FetchJson } from "../_shared/adapters.ts";

/** Serve payloads by URL substring; anything unexpected is a test failure. */
function route(table: Record<string, unknown>): FetchJson {
  return (url: string) => {
    for (const [frag, payload] of Object.entries(table)) {
      if (url.includes(frag)) return Promise.resolve(payload);
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

Deno.test("greenhouse — maps fields and coerces the id to text", async () => {
  const get = route({
    greenhouse: {
      jobs: [{
        id: 4001,
        title: "Director of Operations",
        location: { name: "Buffalo, NY" },
        absolute_url: "https://boards.greenhouse.io/acme/jobs/4001",
        content: "<p>Run the DC.</p>",
        updated_at: "2026-02-01T12:00:00Z",
      }],
    },
  });
  const rows = await fetchGreenhouse({ board_token: "acme" }, get);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ats_job_id, "4001");
  assertEquals(rows[0].title, "Director of Operations");
  assertEquals(rows[0].location, "Buffalo, NY");
  assertEquals(rows[0].description, "Run the DC.");
  assertEquals(rows[0].posted_at, "2026-02-01T12:00:00.000Z");
});

Deno.test("lever — folds the lists into the description, epoch millis to ISO", async () => {
  const get = route({
    lever: [{
      id: "abc-123",
      text: "Plant Manager",
      categories: { location: "Lancaster, NY", department: "Ops" },
      hostedUrl: "https://jobs.lever.co/acme/abc-123",
      descriptionPlain: "Own the plant.",
      lists: [{ text: "Requirements", content: "<li>5 years</li>" }],
      createdAt: 1735689600000,
    }],
  });
  const rows = await fetchLever({ board_token: "acme" }, get);
  assertEquals(rows[0].ats_job_id, "abc-123");
  assertEquals(rows[0].department, "Ops");
  assertStringIncludes(rows[0].description!, "Own the plant.");
  assertStringIncludes(rows[0].description!, "5 years");
  assertEquals(rows[0].posted_at, "2025-01-01T00:00:00.000Z");
});

Deno.test("ashby — captures the compensation summary", async () => {
  const get = route({
    ashbyhq: {
      jobs: [{
        id: "j1",
        title: "Site Manager",
        location: "Amherst, NY",
        department: "Operations",
        jobUrl: "https://jobs.ashbyhq.com/acme/j1",
        descriptionHtml: "<p>Lead the site.</p>",
        compensation: { compensationTierSummary: "$95K – $115K" },
        publishedAt: "2026-03-05T09:00:00Z",
      }],
    },
  });
  const rows = await fetchAshby({ board_token: "acme" }, get);
  assertEquals(rows[0].comp_text, "$95K – $115K");
  assertEquals(rows[0].description, "Lead the site.");
});

Deno.test("smartrecruiters — pages the listing, then fetches each description", async () => {
  const listing = {
    content: [{
      id: "sr1",
      name: "Branch Manager",
      location: { city: "Rochester", region: "NY" },
      department: { label: "Field Ops" },
      releasedDate: "2026-01-15T00:00:00Z",
    }],
    totalFound: 1,
  };
  const detail = {
    jobAd: {
      sections: {
        jobDescription: { text: "<p>Run the branch.</p>" },
        qualifications: { text: "<p>10 years.</p>" },
      },
    },
  };
  // The detail URL is the listing URL plus /sr1, so order matters.
  const get: FetchJson = (url) =>
    Promise.resolve(url.endsWith("/sr1") ? detail : listing);
  const rows = await fetchSmartRecruiters({ board_token: "acme" }, get);
  assertEquals(rows[0].location, "Rochester, NY");
  assertEquals(rows[0].department, "Field Ops");
  assertStringIncludes(rows[0].description!, "Run the branch.");
  assertStringIncludes(rows[0].description!, "10 years.");
});

Deno.test("smartrecruiters — a failed detail call keeps the posting", async () => {
  const listing = { content: [{ id: "sr1", name: "Branch Manager" }], totalFound: 1 };
  const get: FetchJson = (url) => {
    if (url.endsWith("/sr1")) throw new Error("502");
    return Promise.resolve(listing);
  };
  const rows = await fetchSmartRecruiters({ board_token: "acme" }, get);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].description, null);
});

Deno.test("workday — uses externalPath as the id and prefers the canonical url", async () => {
  const listing = {
    jobPostings: [{
      title: "Operations Manager",
      externalPath: "/job/Buffalo/Ops_R-1",
      locationsText: "Buffalo, NY",
      bulletFields: ["R-1"],
    }],
    total: 1,
  };
  const detail = {
    jobPostingInfo: {
      jobDescription: "<p>Own throughput.</p>",
      startDate: "2026-04-01T00:00:00Z",
      externalUrl: "https://acme.wd1.myworkdayjobs.com/en-US/External/job/R-1",
    },
  };
  const call: FetchJson = (url) =>
    Promise.resolve(url.includes("Ops_R-1") ? detail : listing);
  const rows = await fetchWorkday({
    board_token: "acme",
    workday_host: "acme.wd1.myworkdayjobs.com",
    workday_site: "External",
  }, call);
  assertEquals(rows[0].ats_job_id, "/job/Buffalo/Ops_R-1");
  assertEquals(rows[0].description, "Own throughput.");
  assertEquals(rows[0].url, detail.jobPostingInfo.externalUrl);
});

Deno.test("stripHtml", () => {
  assertEquals(stripHtml("<p>a&nbsp;<b>b</b></p><br/>c&amp;d"), "a b \n\nc&d");
  assertEquals(stripHtml(null), "");
  assertEquals(stripHtml(undefined), "");
});

Deno.test("iso", () => {
  assertEquals(iso(1735689600000), "2025-01-01T00:00:00.000Z");
  assertEquals(iso("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
  assertEquals(iso("not a date"), null);
  assertEquals(iso(null), null);
  assertEquals(iso(""), null);
});
