// ATS adapters — one per applicant-tracking system an employer might run.
//
// Every adapter is a pure function of (company, fetchJson). The HTTP client is
// INJECTED so the field mapping is deterministic and offline in tests; the
// production client (see http.ts) adds SSRF validation, timeouts and byte caps.
//
// Ported from the Python starter (ingest.py). The mapping is the part that
// breaks when a board changes its JSON, so it is the part that is tested.

export interface Company {
  id?: number;
  name?: string;
  ats?: string | null;
  board_token?: string | null;
  workday_host?: string | null;
  workday_site?: string | null;
}

export interface Posting {
  ats_job_id: string;
  title: string;
  location: string | null;
  department: string | null;
  url: string | null;
  description: string | null;
  comp_text: string | null;
  posted_at: string | null;
}

/** Injected HTTP client. `body` present => POST JSON, else GET. */
export type FetchJson = (url: string, body?: unknown) => Promise<unknown>;

// ---- normalization ---------------------------------------------------------

export function stripHtml(s: unknown): string {
  if (s === null || s === undefined || s === "") return "";
  let t = String(s);
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/(p|div|li|h\d)>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return t.replace(/[ \t]{2,}/g, " ").trim();
}

/** Normalize whatever the ATS gave us into an ISO timestamp, or null. */
export function iso(ts: unknown): string | null {
  if (ts === null || ts === undefined || ts === "") return null;
  if (typeof ts === "number") {
    // Greenhouse/Lever hand back epoch milliseconds.
    const ms = ts > 1e12 ? ts : ts * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(ts).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function posting(p: Partial<Posting> & { ats_job_id: string }): Posting {
  return {
    ats_job_id: p.ats_job_id,
    title: p.title ?? "",
    location: p.location ?? null,
    department: p.department ?? null,
    url: p.url ?? null,
    description: p.description ?? null,
    comp_text: p.comp_text ?? null,
    posted_at: p.posted_at ?? null,
  };
}

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- adapters --------------------------------------------------------------

export async function fetchGreenhouse(c: Company, get: FetchJson): Promise<Posting[]> {
  const d = await get(
    `https://boards-api.greenhouse.io/v1/boards/${c.board_token}/jobs?content=true`,
  ) as Any;
  return (d?.jobs ?? []).map((j: Any) =>
    posting({
      ats_job_id: String(j.id),
      title: j.title ?? "",
      location: j.location?.name ?? null,
      url: j.absolute_url ?? null,
      description: stripHtml(j.content) || null,
      posted_at: iso(j.updated_at ?? j.first_published),
    })
  );
}

export async function fetchLever(c: Company, get: FetchJson): Promise<Posting[]> {
  const d = await get(
    `https://api.lever.co/v0/postings/${c.board_token}?mode=json`,
  ) as Any;
  return (d ?? []).map((j: Any) => {
    const cat = j.categories ?? {};
    const lists = (j.lists ?? [])
      .map((l: Any) => `${stripHtml(l.text)}\n${stripHtml(l.content)}`)
      .join("\n");
    const body = `${j.descriptionPlain ?? j.description ?? ""}\n${lists}`;
    return posting({
      ats_job_id: String(j.id),
      title: j.text ?? "",
      location: cat.location ?? null,
      department: cat.department ?? cat.team ?? null,
      url: j.hostedUrl ?? null,
      description: stripHtml(body) || null,
      posted_at: iso(j.createdAt),
    });
  });
}

export async function fetchAshby(c: Company, get: FetchJson): Promise<Posting[]> {
  const d = await get(
    `https://api.ashbyhq.com/posting-api/job-board/${c.board_token}?includeCompensation=true`,
  ) as Any;
  return (d?.jobs ?? []).map((j: Any) =>
    posting({
      ats_job_id: String(j.id),
      title: j.title ?? "",
      location: j.location ?? null,
      department: j.department ?? j.team ?? null,
      url: j.jobUrl ?? null,
      description: stripHtml(j.descriptionHtml ?? j.descriptionPlain) || null,
      comp_text: j.compensation?.compensationTierSummary ?? null,
      posted_at: iso(j.publishedAt),
    })
  );
}

export async function fetchSmartRecruiters(c: Company, get: FetchJson): Promise<Posting[]> {
  const tok = c.board_token;
  const out: Posting[] = [];
  let offset = 0;
  // Paginate the listing endpoint.
  for (;;) {
    const d = await get(
      `https://api.smartrecruiters.com/v1/companies/${tok}/postings?limit=100&offset=${offset}`,
    ) as Any;
    const items: Any[] = d?.content ?? [];
    for (const j of items) {
      const loc = j.location ?? {};
      out.push(posting({
        ats_job_id: String(j.id),
        title: j.name ?? "",
        location: [loc.city, loc.region].filter(Boolean).join(", ") || null,
        department: j.department?.label ?? null,
        url: `https://jobs.smartrecruiters.com/${tok}/${j.id}`,
        posted_at: iso(j.releasedDate),
      }));
    }
    offset += items.length;
    if (items.length < 100 || offset >= (d?.totalFound ?? 0)) break;
  }
  // Descriptions live on the detail endpoint, one call each.
  for (const row of out) {
    try {
      const det = await get(
        `https://api.smartrecruiters.com/v1/companies/${tok}/postings/${row.ats_job_id}`,
      ) as Any;
      const secs = det?.jobAd?.sections ?? {};
      row.description = stripHtml(
        ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
          .map((k) => secs[k]?.text ?? "")
          .join(" "),
      ) || null;
    } catch {
      // A missing description is not a reason to drop a real posting.
    }
  }
  return out;
}

export async function fetchWorkday(c: Company, call: FetchJson): Promise<Posting[]> {
  // Workday has no public API; its own front end POSTs to this endpoint.
  const host = c.workday_host;
  const tenant = c.board_token;
  const site = c.workday_site || "External";
  const base = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const out: Posting[] = [];
  let offset = 0;
  for (;;) {
    const d = await call(base, {
      appliedFacets: {},
      limit: 20,
      offset,
      searchText: "",
    }) as Any;
    const posts: Any[] = d?.jobPostings ?? [];
    for (const j of posts) {
      const path = j.externalPath ?? "";
      out.push(posting({
        ats_job_id: path || j.bulletFields?.[0] || "",
        title: j.title ?? "",
        location: j.locationsText ?? null,
        url: path.startsWith("http")
          ? path
          : `https://${host}/${[tenant, site].filter(Boolean).join("/")}${path}`,
      }));
    }
    offset += posts.length;
    if (posts.length < 20 || offset >= (d?.total ?? 0)) break;
  }
  for (const row of out) {
    if (!row.ats_job_id.startsWith("/")) continue;
    try {
      const det = await call(
        `https://${host}/wday/cxs/${tenant}/${site}${row.ats_job_id}`,
      ) as Any;
      const ji = det?.jobPostingInfo ?? {};
      row.description = stripHtml(ji.jobDescription) || null;
      row.posted_at = iso(ji.startDate);
      row.url = ji.externalUrl ?? row.url;
    } catch {
      // Same as SmartRecruiters: keep the posting, lose the description.
    }
  }
  return out;
}


/**
 * ADP WorkforceNow.
 *
 * The matter of coverage, not elegance: four in-radius employers sit behind
 * ADP — Sonwil Distribution Center, McGard, PCB Piezotronics and New Era Cap —
 * and three of those are exactly the private, single-site WNY manufacturers
 * this search is aimed at. Discovery found them months before anything could
 * read them.
 *
 * ADP publishes no documented API, but its own career-centre front end reads
 * these public endpoints, and the board_token discovery already stores is the
 * `cid` GUID they key on. Every field name below was read off a live response
 * from Sonwil's board rather than guessed.
 *
 * Unusually, ADP returns pay as NUMBERS (payGradeRange), so these postings
 * arrive with real compensation instead of a sentence to parse.
 */
const ADP_BASE =
  "https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions";

/**
 * ADP states an amount and a currency but never a UNIT — 19.56 and 95000 look
 * the same in the JSON. Nobody earns $19.56 a year and nobody earns $95,000 an
 * hour, so the magnitude settles it. The threshold sits well clear of both
 * (a $999/hr consultant and a $1,000/yr stipend are not roles this searches
 * for), and the unit travels with the value so the scorer is never left to
 * guess whether $22 means an hour or a year.
 */
export function adpPay(range: unknown): string | null {
  const r = (range ?? {}) as Any;
  const lo = r?.minimumRate?.amountValue;
  const hi = r?.maximumRate?.amountValue;
  const n = typeof lo === "number" ? lo : typeof hi === "number" ? hi : null;
  if (n === null) return null;
  const per = n < 1000 ? "per hour" : "per year";
  const fmt = (v: number) =>
    `$${v.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 })}`;
  if (typeof lo === "number" && typeof hi === "number" && hi !== lo) {
    return `${fmt(lo)} - ${fmt(hi)} ${per}`;
  }
  return `${fmt(n)} ${per}`;
}

/** "BUFFALO, NY" from the address, falling back to ADP's own display name. */
export function adpLocation(locs: unknown): string | null {
  const first = (Array.isArray(locs) ? locs[0] : null) as Any;
  if (!first) return null;
  const a = first.address ?? {};
  const city = a.cityName ? String(a.cityName).trim() : "";
  const st = a.countrySubdivisionLevel1?.codeValue ?? "";
  const zip = a.postalCode ?? "";
  // Prefer city + state + ZIP: the ZIP lets the radius gate resolve exactly
  // rather than by name, which is the difference between a match and a guess.
  const built = [city && st ? `${city}, ${st}` : city || st, zip]
    .filter(Boolean).join(" ").trim();
  if (built) return built;
  const short = first.nameCode?.shortName;
  return short ? String(short).trim() : null;
}

export async function fetchAdp(c: Company, get: FetchJson): Promise<Posting[]> {
  const cid = c.board_token;
  const tz = "America%2FNew_York";
  const page = 50;
  const out: Posting[] = [];

  for (let skip = 0; skip < 1000; skip += page) {
    const d = await get(
      `${ADP_BASE}?cid=${cid}&timeZoneId=${tz}&%24top=${page}&%24skip=${skip}`,
    ) as Any;
    const items: Any[] = d?.jobRequisitions ?? [];
    for (const j of items) {
      const id = String(j.itemID ?? "");
      if (!id) continue;
      out.push(posting({
        ats_job_id: id,
        title: j.requisitionTitle ?? "",
        location: adpLocation(j.requisitionLocations),
        comp_text: adpPay(j.payGradeRange),
        posted_at: iso(j.postDate),
        url: `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/` +
          `recruitment.html?cid=${cid}&jobId=${id}&lang=en_US`,
      }));
    }
    if (items.length < page) break;
  }

  // The description lives only on the detail endpoint, one call per posting.
  for (const row of out) {
    try {
      const det = await get(
        `${ADP_BASE}/${row.ats_job_id}?cid=${cid}&timeZoneId=${tz}`,
      ) as Any;
      row.description = stripHtml(det?.requisitionDescription) || null;
    } catch {
      // Same rule as SmartRecruiters and Workday: keep the posting, lose the
      // description. A posting we cannot fully describe still beats silence.
    }
  }
  return out;
}

export const ADAPTERS: Record<string, (c: Company, f: FetchJson) => Promise<Posting[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workday: fetchWorkday,
  adp: fetchAdp,
};

/** ATS we can ingest today. Everything else is detected but needs an adapter. */
export const SUPPORTED = new Set(Object.keys(ADAPTERS));
