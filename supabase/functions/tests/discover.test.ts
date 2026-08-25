import { assertEquals } from "./assert.ts";
import {
  findCareersPage, fingerprint, probe, type FetchPage,
} from "../_shared/discover.ts";

const page = (html: string, finalUrl = "https://acme.com/careers") =>
  Promise.resolve({ html, finalUrl });

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
