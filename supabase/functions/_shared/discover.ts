// ATS detection — given a company's website, work out which applicant-tracking
// system they run and the board token the adapters need.
//
// This is the step that turns a list of company names into a working crawler.
// The page fetch is INJECTED so the fingerprinting is testable offline.
//
// Ported from the Python starter (discover.py). Every return path has the same
// shape — ats/board_token/supported always set — because the original could
// return a record with no `ats` key on a failed fetch and crash the caller.

// Deliberately NOT imported from adapters.ts. Discovery only needs to know
// WHICH systems are ingestible, not how to ingest them, and keeping the import
// out means the deployed discover function does not carry all five adapters.
// tests/discover.test.ts asserts this list still equals Object.keys(ADAPTERS),
// so adding an adapter without updating it fails the suite.
export const INGESTIBLE = new Set([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
]);

export interface Detection {
  ats: string;
  board_token: string | null;
  supported: boolean;
  evidence: string;
  careers_url?: string;
  workday_host?: string;
  workday_site?: string;
}

/** Injected page fetch: returns the body and the URL after redirects. */
export type FetchPage = (url: string) => Promise<{ html: string; finalUrl: string }>;

// Each pattern pulls the board token out of whatever URL the page links to.
export const SIGNATURES: [string, RegExp][] = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-zA-Z0-9_-]+)/],
  ["lever", /jobs\.lever\.co\/([a-zA-Z0-9_-]+)/],
  ["ashby", /jobs\.ashbyhq\.com\/([a-zA-Z0-9_-]+)/],
  ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/],
  ["workday", /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([a-zA-Z0-9_-]+)/],
  ["icims", /([a-zA-Z0-9-]+)\.icims\.com/],
  ["paylocity", /recruiting\.paylocity\.com\/recruiting\/jobs\/List\/(\d+)/],
  ["adp", /workforcenow\.adp\.com\/(?:mascsr\/default\/mdf\/recruitment\/recruitment\.html\?cid=)?([a-f0-9-]{20,})/],
  // recruiting.ultipro.com is the SHARED host every UKG customer sits behind,
  // so the subdomain is not a tenant id — the tenant is the first path segment
  // (e.g. recruiting.ultipro.com/ROS1004ROSIN/JobBoard/...). Matching the
  // subdomain recorded "recruiting" as the board token for three different
  // employers, which is a wrong value stored as if it were right.
  ["ukg", /(?:recruiting|recruiting\d*)\.(?:ultipro|ukg)\.com\/([A-Za-z0-9_-]{4,})/],
  ["ukg", /(?!recruiting|www)([a-zA-Z0-9-]+)\.(?:ultipro|ukg)\.com/],
  ["jazzhr", /([a-zA-Z0-9-]+)\.applytojob\.com/],
  ["bamboohr", /([a-zA-Z0-9-]+)\.bamboohr\.com\/(?:jobs|careers)/],
  ["paycom", /paycomonline\.net\/v4\/ats\/web\.php\/jobs\?clientkey=([A-F0-9]+)/],
  ["taleo", /([a-zA-Z0-9-]+)\.taleo\.net/],
  ["recruitee", /([a-zA-Z0-9-]+)\.recruitee\.com/],
  ["workable", /apply\.workable\.com\/([a-zA-Z0-9_-]+)/],
];

// Ordered by observed yield. Every extra hint is another full page fetch held
// in memory, and the edge runtime kills the worker before politeness does —
// the first real run died with WORKER_RESOURCE_LIMIT after four companies.
export const CAREER_HINTS = [
  "/careers", "/careers/", "/career", "/jobs", "/employment", "/join-us",
];

/** The shape every caller can rely on. */
export function unresolved(evidence: string, extra: Partial<Detection> = {}): Detection {
  return { ats: "unknown", board_token: null, supported: false, evidence, ...extra };
}

// A cheap substring gate in front of each pattern. Running 15 regexes over a
// few hundred KB of markup, for 7 pages per company, is what burned the edge
// worker's CPU budget — indexOf is an order of magnitude cheaper than a regex
// scan, and it rules out almost every pattern on almost every page.
const MARKERS: Record<string, string[]> = {
  greenhouse: ["greenhouse.io"],
  lever: ["lever.co"],
  ashby: ["ashbyhq.com"],
  smartrecruiters: ["smartrecruiters.com"],
  workday: ["myworkdayjobs.com"],
  icims: ["icims.com"],
  paylocity: ["paylocity.com"],
  adp: ["adp.com"],
  ukg: ["ultipro.com", "ukg.com"],
  jazzhr: ["applytojob.com"],
  bamboohr: ["bamboohr.com"],
  paycom: ["paycomonline.net"],
  taleo: ["taleo.net"],
  recruitee: ["recruitee.com"],
  workable: ["workable.com"],
};

export function fingerprint(html: string, finalUrl: string): Detection | null {
  const hay = html.toLowerCase();
  const url = finalUrl.toLowerCase();
  for (const [ats, pat] of SIGNATURES) {
    const markers = MARKERS[ats];
    if (markers && !markers.some((m) => hay.includes(m) || url.includes(m))) continue;
    const m = pat.exec(html) ?? pat.exec(finalUrl);
    if (!m) continue;
    const rec: Detection = {
      ats,
      board_token: m[1],
      supported: INGESTIBLE.has(ats),
      evidence: m[0].slice(0, 120),
    };
    if (ats === "workday") {
      rec.workday_host = `${m[1]}.${m[2]}.myworkdayjobs.com`;
      rec.workday_site = m[3];
    }
    return rec;
  }
  return null;
}

export async function probe(url: string, get: FetchPage): Promise<Detection> {
  let page: { html: string; finalUrl: string };
  try {
    page = await get(url);
  } catch (e) {
    return unresolved((e as Error).message || (e as Error).name);
  }
  return fingerprint(page.html, page.finalUrl) ?? unresolved("no ATS link");
}

export interface FindOptions {
  /** Wall-clock ceiling for ONE company, so a slow site cannot eat the run. */
  deadlineMs?: number;
  now?: () => number;
}

/**
 * Given a company homepage, try the homepage then the usual careers paths.
 *
 * On failure the evidence records what actually happened at each URL — "404 at
 * /careers, 403 at /jobs" is actionable, "no careers page found" is not, and
 * telling a bot-blocked site apart from one with no ATS is the whole question
 * this function exists to answer.
 */
export async function findCareersPage(
  root: string,
  get: FetchPage,
  opts: FindOptions = {},
): Promise<Detection> {
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.deadlineMs ?? 45_000);

  let base: string;
  try {
    const u = new URL(root.startsWith("http") ? root : `https://${root}`);
    base = `${u.protocol}//${u.host}`;
  } catch {
    return unresolved(`malformed website: ${root}`);
  }

  const tried: string[] = [];

  const home = await probe(base, get);
  if (home.ats !== "unknown") return { ...home, careers_url: base };
  tried.push(`/: ${home.evidence}`);

  for (const hint of CAREER_HINTS) {
    if (now() >= deadline) {
      tried.push("deadline reached — remaining paths not tried");
      break;
    }
    const res = await probe(base + hint, get);
    if (res.ats !== "unknown") return { ...res, careers_url: base + hint };
    tried.push(`${hint}: ${res.evidence}`);
  }
  return unresolved(tried.join(" | ").slice(0, 500), { careers_url: base });
}
