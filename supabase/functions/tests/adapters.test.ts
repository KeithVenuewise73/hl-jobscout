// Adapter parsing — recorded ATS payloads, no network.
//
// These prove the field mapping, not the live boards. A board that changes its
// JSON shape will still break ingest and these will still pass; only a real
// crawl catches that.

import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  adpLocation, adpPay, fetchAdp, fetchAshby, fetchGreenhouse, fetchLever,
  fetchSmartRecruiters, fetchWorkday, iso, stripHtml,
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

Deno.test("ADP: the listing maps to postings, with pay as a real number", () => {
  // Field names below are verbatim from a live response on Sonwil's board —
  // not guessed. ADP is unusual in returning pay as numbers rather than prose.
  return (async () => {
    const calls: string[] = [];
    const get: FetchJson = (url) => {
      calls.push(url);
      if (url.includes("/9201845720623_1?")) {
        return Promise.resolve({
          requisitionDescription:
            "<div><p><strong>Job purpose</strong></p><p>Run the shift.</p></div>",
        });
      }
      if (url.includes("%24skip=0")) {
        return Promise.resolve({
          jobRequisitions: [{
            itemID: "9201845720623_1",
            requisitionTitle: "Operations Manager",
            postDate: "2026-08-17T15:47:00.000-04:00",
            payGradeRange: {
              minimumRate: { amountValue: 95000, currencyCode: "USD" },
              maximumRate: { amountValue: 125000, currencyCode: "USD" },
            },
            requisitionLocations: [{
              address: {
                cityName: "BUFFALO",
                postalCode: "14218",
                countrySubdivisionLevel1: { codeValue: "NY" },
              },
              nameCode: { shortName: " BUFFALO, NY, US" },
            }],
          }],
        });
      }
      return Promise.resolve({ jobRequisitions: [] });
    };

    const rows = await fetchAdp(
      { board_token: "7a483835-9c14-464f-a78e-f6e21d9d4b61" },
      get,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].ats_job_id, "9201845720623_1");
    assertEquals(rows[0].title, "Operations Manager");
    assertEquals(rows[0].comp_text, "$95,000 - $125,000 per year");
    // The ZIP is carried so the radius gate can resolve exactly, not by name.
    assertEquals(rows[0].location, "BUFFALO, NY 14218");
    assertStringIncludes(rows[0].description ?? "", "Job purpose");
    assertStringIncludes(rows[0].url ?? "", "jobId=9201845720623_1");
    assertTrue((rows[0].posted_at ?? "").startsWith("2026-08-17"));
  })();
});

Deno.test("ADP pay: the unit is inferred from magnitude, because ADP states none", () => {
  // 19.56 and 95000 are indistinguishable in the JSON — there is no unit field.
  // Getting this wrong is not cosmetic: the scorer caps a job at 25 when pay is
  // below the floor, so "$19.56 per year" would reject a real role, and
  // "$95,000 per hour" would promote a warehouse shift.
  assertEquals(
    adpPay({ minimumRate: { amountValue: 19.56 }, maximumRate: { amountValue: 22.15 } }),
    "$19.56 - $22.15 per hour",
  );
  assertEquals(
    adpPay({ minimumRate: { amountValue: 95000 }, maximumRate: { amountValue: 125000 } }),
    "$95,000 - $125,000 per year",
  );
  // One-sided and equal ranges collapse to a single figure.
  assertEquals(adpPay({ minimumRate: { amountValue: 110000 } }), "$110,000 per year");
  assertEquals(
    adpPay({ minimumRate: { amountValue: 110000 }, maximumRate: { amountValue: 110000 } }),
    "$110,000 per year",
  );
  // No pay stated is null, never a fabricated zero.
  assertEquals(adpPay({}), null);
  assertEquals(adpPay(null), null);
});

Deno.test("ADP location falls back to the display name when the address is thin", () => {
  assertEquals(adpLocation([{ nameCode: { shortName: " REMOTE, US" } }]), "REMOTE, US");
  assertEquals(adpLocation([]), null);
  assertEquals(adpLocation(null), null);
  // City with no ZIP still yields something the gazetteer can resolve.
  assertEquals(
    adpLocation([{ address: { cityName: "Depew", countrySubdivisionLevel1: { codeValue: "NY" } } }]),
    "Depew, NY",
  );
});

Deno.test("ADP paginates until a short page, and stops", () => {
  return (async () => {
    let pages = 0;
    const get: FetchJson = (url) => {
      if (url.includes("job-requisitions/")) return Promise.resolve({});
      pages++;
      // Two full pages then a short one.
      const n = pages <= 2 ? 50 : 3;
      return Promise.resolve({
        jobRequisitions: Array.from({ length: n }, (_, i) => ({
          itemID: `p${pages}-${i}`,
          requisitionTitle: "Manager",
        })),
      });
    };
    const rows = await fetchAdp({ board_token: "x" }, get);
    assertEquals(rows.length, 103);
    assertEquals(pages, 3);
  })();
});
