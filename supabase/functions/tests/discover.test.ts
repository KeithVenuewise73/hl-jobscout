import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import {
  findCareersPage, fingerprint, INGESTIBLE, probe, shortError, type FetchPage,
} from "../_shared/discover.ts";
import { ADAPTERS } from "../_shared/adapters.ts";

const page = (html: string, finalUrl = "https://acme.com/careers") =>
  Promise.resolve({ html, finalUrl });

Deno.test("INGESTIBLE stays in step with the adapters that actually exist", () => {
  // discover.ts keeps its own copy so the deployed function need not carry the
  // adapters. This is the tripwire that stops the two from drifting apart.
  assertEquals([...INGESTIBLE].sort(), Object.keys(ADAPTERS).sort());
});

Deno.test("fingerprints the boards we can actually ingest", () => {
  const gh = fingerprint('<a href="https://boards.greenhouse.io/acmecorp">Jobs</a>', "");
  assertEquals(gh!.ats, "greenhouse");
  assertEquals(gh!.board_token, "acmecorp");
  assertEquals(gh!.supported, true);

  const lv = fingerprint('<a href="https://jobs.lever.co/acme">Jobs</a>', "");
  assertEquals(lv!.ats, "lever");
  assertEquals(lv!.board_token, "acme");
});

Deno.test("workday detection carries the host and site the adapter needs", () => {
  const wd = fingerprint(
    '<iframe src="https://acme.wd1.myworkdayjobs.com/en-US/External"></iframe>', "",
  );
  assertEquals(wd!.ats, "workday");
  assertEquals(wd!.board_token, "acme");
  assertEquals(wd!.workday_host, "acme.wd1.myworkdayjobs.com");
  assertEquals(wd!.workday_site, "External");
  assertEquals(wd!.supported, true);
});

Deno.test("an ATS we detect but cannot ingest is flagged unsupported, not dropped", () => {
  const ic = fingerprint('<a href="https://acme.icims.com/jobs">Careers</a>', "");
  assertEquals(ic!.ats, "icims");
  assertEquals(ic!.supported, false);   // still your target list — needs an adapter
});

Deno.test("UKG token is the tenant path, not the shared 'recruiting' host", () => {
  // The first live run recorded board_token='recruiting' for Rosina, Upstate
  // Niagara and Curbell — every UKG customer sits behind the same host, so the
  // subdomain identifies nobody. The tenant is the first path segment.
  const u = fingerprint(
    '<a href="https://recruiting.ultipro.com/ROS1004ROSIN/JobBoard/x">Careers</a>', "",
  );
  assertEquals(u!.ats, "ukg");
  assertEquals(u!.board_token, "ROS1004ROSIN");
  // A genuine per-tenant subdomain still resolves to that subdomain.
  const v = fingerprint('<a href="https://acmecorp.ultipro.com/jobs">Jobs</a>', "");
  assertEquals(v!.ats, "ukg");
  assertEquals(v!.board_token, "acmecorp");
});

Deno.test("a failed fetch returns a well-formed record, not a crash", async () => {
  const dead: FetchPage = () => Promise.reject(new TypeError("connection refused"));
  const r = await probe("https://acme.com", dead);
  // The original Python returned {error: ...} with no `ats` key here, and the
  // CSV run died formatting it on the first unreachable site.
  assertEquals(r.ats, "unknown");
  assertEquals(r.board_token, null);
  assertEquals(r.supported, false);
  assertEquals(typeof r.evidence, "string");
});

Deno.test("falls through the careers paths and reports where it found the board", async () => {
  const get: FetchPage = (url) =>
    url.endsWith("/careers")
      ? page('<a href="https://jobs.lever.co/acme">Openings</a>', url)
      : page("<html>nothing here</html>", url);
  const r = await findCareersPage("acme.com", get);
  assertEquals(r.ats, "lever");
  assertEquals(r.careers_url, "https://acme.com/careers");
});

Deno.test("a site with no ATS anywhere is still a well-formed row", async () => {
  const get: FetchPage = (url) => page("<html>family business</html>", url);
  const r = await findCareersPage("smallco.com", get);
  assertEquals(r.ats, "unknown");
  assertEquals(r.supported, false);
  assertEquals(r.careers_url, "https://smallco.com");
});

Deno.test("evidence records what happened at each path, not just 'not found'", async () => {
  // A bot-blocked site and a site with no ATS are completely different answers.
  const get: FetchPage = (url) => {
    if (url.endsWith("/careers")) return Promise.reject(new Error("http_403"));
    if (url.endsWith("/jobs")) return Promise.reject(new Error("http_404"));
    return page("<html>nothing</html>", url);
  };
  const r = await findCareersPage("acme.com", get);
  assertEquals(r.ats, "unknown");
  // The reason for each URL survives into the record.
  assertEquals(r.evidence.includes("http_403"), true);
  assertEquals(r.evidence.includes("http_404"), true);
});

Deno.test("a slow site cannot eat the whole run", async () => {
  let t = 0;
  const now = () => (t += 30_000);   // every check jumps 30s
  let calls = 0;
  const get: FetchPage = (url) => {
    calls++;
    return page("<html>nothing</html>", url);
  };
  const r = await findCareersPage("slow.com", get, { deadlineMs: 45_000, now });
  assertEquals(r.ats, "unknown");
  assertEquals(r.evidence.includes("deadline reached"), true);
  // Homepage plus at most one hint, not all of them.
  assertEquals(calls <= 2, true);
});

Deno.test("a malformed website field does not throw", async () => {
  const get: FetchPage = () => Promise.reject(new Error("never called"));
  const r = await findCareersPage("http://[not a url", get);
  assertEquals(r.ats, "unknown");
});

Deno.test("careers on a subdomain are found — the homepage cannot show them", () => {
  // International Paper was recorded as "no ATS link" while its board sat at
  // jobs.internationalpaper.com. Probing the homepage and a list of paths
  // cannot find that, however many paths you add.
  return (async () => {
    const get: FetchPage = (url) => {
      if (url === "https://jobs.internationalpaper.com") {
        return Promise.resolve({
          html: `<a href="https://internationalpaper.wd5.myworkdayjobs.com/en-US/IP_Careers">Search</a>`,
          finalUrl: url,
        });
      }
      return Promise.reject(new Error("ENOTFOUND"));
    };
    const d = await findCareersPage("https://www.internationalpaper.com", get);
    assertEquals(d.ats, "workday");
    assertEquals(d.supported, true);
    assertEquals(d.careers_url, "https://jobs.internationalpaper.com");
  })();
});

Deno.test("a locale-prefixed careers path is tried", () => {
  // Atlas Copco — the employer whose Sanborn role started this — 404s on every
  // bare path and serves its careers site from /en/careers.
  return (async () => {
    const get: FetchPage = (url) => {
      if (url === "https://www.atlascopcogroup.com/en/careers") {
        return Promise.resolve({
          html: `<a href="https://atlascopco.wd3.myworkdayjobs.com/en-US/AtlasCopco">Jobs</a>`,
          finalUrl: url,
        });
      }
      if (url.includes("jobs.") || url.includes("careers.")) {
        return Promise.reject(new Error("ENOTFOUND"));
      }
      return Promise.resolve({ html: "<p>products</p>", finalUrl: url });
    };
    const d = await findCareersPage("https://www.atlascopcogroup.com", get);
    assertEquals(d.ats, "workday");
    assertEquals(d.careers_url, "https://www.atlascopcogroup.com/en/careers");
  })();
});

Deno.test("subdomain probing does not stack onto an already-deep host", () => {
  // "jobs.careers.eu.acme.co.uk" is not a guess worth making, and each one
  // costs a DNS round trip inside a per-company deadline.
  return (async () => {
    const seen: string[] = [];
    const get: FetchPage = (url) => {
      seen.push(url);
      return Promise.resolve({ html: "<p>nothing</p>", finalUrl: url });
    };
    await findCareersPage("https://careers.eu.acme.co.uk", get);
    assertTrue(!seen.some((u) => u.startsWith("https://jobs.careers.")), seen.join(","));
  })();
});

Deno.test("evidence still names what was tried, subdomains included", () => {
  return (async () => {
    const get: FetchPage = (url) =>
      url.includes("jobs.")
        ? Promise.reject(new Error("ENOTFOUND"))
        : Promise.resolve({ html: "<p>none</p>", finalUrl: url });
    const d = await findCareersPage("https://acme.com", get);
    assertEquals(d.ats, "unknown");
    assertStringIncludes(d.evidence, "jobs.acme.com");
    assertStringIncludes(d.evidence, "ENOTFOUND");
  })();
});

Deno.test("a verbose fetch error cannot crowd out the rest of the evidence", () => {
  // Deno reports a missing host as ~190 characters. Two of those overflowed the
  // whole 500-char evidence field on a real run, so nothing could be seen about
  // any later candidate — and "what happened at each URL" is the only question
  // this field exists to answer.
  const dns =
    "error sending request for url (https://jobs.acme.com/): client error " +
    "(Connect): dns error: failed to lookup address information: Name or " +
    "service not known: failed to lookup address information: Name or " +
    "service not known";
  assertEquals(shortError(new Error(dns)), "no such host");
  assertEquals(shortError(new Error("operation timed out")), "timeout");

  return (async () => {
    const get: FetchPage = (url) =>
      url.includes("jobs.") || url.includes("careers.")
        ? Promise.reject(new Error(dns))
        : Promise.resolve({ html: "<p>none</p>", finalUrl: url });
    const d = await findCareersPage("https://acme.com", get);
    // Every candidate is still visible, including the last path tried.
    assertStringIncludes(d.evidence, "jobs.acme.com: no such host");
    assertStringIncludes(d.evidence, "/en-us/jobs");
    assertTrue(d.evidence.length < 500, `evidence was ${d.evidence.length} chars`);
  })();
});
