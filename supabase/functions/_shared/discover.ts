// ATS detection — given a company's website, work out which applicant-tracking
// system they run and the board token the adapters need.
//
// This is the step that turns a list of company names into a working crawler.
// The page fetch is INJECTED so the fingerprinting is testable offline.
//
// Ported from the Python starter (discover.py). Every return path has the same
// shape — ats/board_token/supported always set — because the original could
// return a record with no `ats` key on a failed fetch and crash the caller.

import { SUPPORTED } from "./adapters.ts";

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
  ["ukg", /([a-zA-Z0-9-]+)\.(?:ultipro|ukg)\.com/],
  ["jazzhr", /([a-zA-Z0-9-]+)\.applytojob\.com/],
  ["bamboohr", /([a-zA-Z0-9-]+)\.bamboohr\.com\/(?:jobs|careers)/],
  ["paycom", /paycomonline\.net\/v4\/ats\/web\.php\/jobs\?clientkey=([A-F0-9]+)/],
  ["taleo", /([a-zA-Z0-9-]+)\.taleo\.net/],
  ["recruitee", /([a-zA-Z0-9-]+)\.recruitee\.com/],
  ["workable", /apply\.workable\.com\/([a-zA-Z0-9_-]+)/],
];

export const CAREER_HINTS = [
  "/careers", "/career", "/jobs", "/join-us", "/employment",
  "/work-with-us", "/opportunities", "/about/careers",
];

/** The shape every caller can rely on. */
export function unresolved(evidence: string, extra: Partial<Detection> = {}): Detection {
  return { ats: "unknown", board_token: null, supported: false, evidence, ...extra };
}

export function fingerprint(html: string, finalUrl: string): Detection | null {
  for (const [ats, pat] of SIGNATURES) {
    const m = pat.exec(html) ?? pat.exec(finalUrl);
    if (!m) continue;
    const rec: Detection = {
      ats,
      board_token: m[1],
      supported: SUPPORTED.has(ats),
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
    return unresolved(`${(e as Error).name} fetching ${url}`);
  }
  return fingerprint(page.html, page.finalUrl)
    ?? unresolved(`no ATS signature at ${page.finalUrl}`);
}

/** Given a company homepage, try the homepage then the usual careers paths. */
export async function findCareersPage(root: string, get: FetchPage): Promise<Detection> {
  let base: string;
  try {
    const u = new URL(root.startsWith("http") ? root : `https://${root}`);
    base = `${u.protocol}//${u.host}`;
  } catch {
    return unresolved(`malformed website: ${root}`);
  }

  const home = await probe(base, get);
  if (home.ats !== "unknown") return { ...home, careers_url: base };

  for (const hint of CAREER_HINTS) {
    const u = base + hint;
    const res = await probe(u, get);
    if (res.ats !== "unknown") return { ...res, careers_url: u };
  }
  return unresolved("no careers page found", { careers_url: base });
}
