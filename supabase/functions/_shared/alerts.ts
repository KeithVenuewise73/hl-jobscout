// Parse Indeed and LinkedIn job-alert emails into postings.
//
// Keith subscribes to these alerts as an ordinary user and they arrive in his
// inbox. That makes this the one compliant route into Indeed and LinkedIn data:
// Indeed has no public API and answers scrapers with a Cloudflare 403, and
// LinkedIn's terms prohibit automated access (hiQ won on the CFAA and still
// lost on breach of contract). Reading mail he asked to receive is neither.
//
// Why this matters more than it looks: the alerts are query-first, not
// employer-first. They surface jobs at companies the crawler has never heard
// of — which makes them a source of EMPLOYERS, not just postings.

export interface AlertPosting {
  source: "indeed" | "linkedin";
  /** Stable across re-sends of the same job. See the ID notes below. */
  ats_job_id: string;
  title: string;
  company: string;
  location: string | null;
  comp_text: string | null;
  description: string | null;
  url: string | null;
  /** "Just posted", "3 days ago" — kept verbatim, not parsed into a date. */
  posted_hint: string | null;
}

/** Lines Indeed and LinkedIn interleave that are not part of a posting. */
const BADGE = new RegExp(
  "^(easily apply|responsive employer|urgently hiring|hiring multiple candidates" +
    "|apply with resume & profile|be an early applicant|actively reviewing" +
    "|this company is actively hiring|fast growing|promoted|viewed" +
    "|\\d+ (school )?alum(ni)?|\\d+ connections?)$",
  "i",
);

const RECENCY = /^(just posted|today|yesterday|active \d+ days ago|\d+\+? (minute|hour|day|week|month)s? ago|posted \d+.*)$/i;
const PAY = /^[$€£]|^\d+(\.\d+)?\s*-\s*[$\d]|\ban hour\b|\ba year\b|\bper hour\b|\bper year\b/i;

/**
 * Indeed's plaintext eats the "=" in query strings, so the jk= job id arrives
 * corrupted ("jkK3d58141c0f9b1f", "jkc3ac8899753cce"). Rather than parse
 * a value we know is damaged, derive the id from the fields we CAN read. Same
 * job in tomorrow's digest hashes the same and dedupes.
 */
export function stableId(prefix: string, ...parts: (string | null)[]): string {
  const s = parts.map((p) => (p ?? "").trim().toLowerCase()).join("|");
  // FNV-1a. Not cryptographic — this only needs to be stable and collision-shy
  // across a few thousand postings.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}-${h.toString(16).padStart(8, "0")}`;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Indeed digest. Each posting is a run of lines beginning with the title:
 *
 *   Operations Supervisor
 *   Ryerson - Lancaster, NY
 *   $64,855.53 - $97,283.29 a year      <- optional, and often an ESTIMATE
 *   Easily apply                         <- optional badge
 *   As a Service Center Operations...    <- snippet
 *   1 day ago
 *   https://www.indeed.com/rc/clk/dl?...
 */
export function parseIndeedAlert(body: string): AlertPosting[] {
  const out: AlertPosting[] = [];
  // Every posting ends at its Indeed link; split there and read backwards.
  const blocks = body.split(/\n(?=https:\/\/www\.indeed\.com\/(?:rc\/clk|pagead\/clk))/);

  for (let i = 0; i < blocks.length - 1; i++) {
    const url = (blocks[i + 1].match(/^(https:\/\/www\.indeed\.com\/\S+)/) ?? [])[1] ?? null;
    const lines = blocks[i].split("\n").map(clean).filter(Boolean);

    // Walk back to the "Company - Location" line; the title sits above it.
    let coIdx = -1;
    for (let j = lines.length - 1; j >= 1; j--) {
      if (/ - /.test(lines[j]) && !PAY.test(lines[j]) && !RECENCY.test(lines[j])) {
        coIdx = j;
        break;
      }
    }
    if (coIdx < 1) continue;

    const title = lines[coIdx - 1];
    if (!title || title.length > 200) continue;
    const [company, ...locParts] = lines[coIdx].split(" - ");
    const rest = lines.slice(coIdx + 1);

    const comp = rest.find((l) => PAY.test(l)) ?? null;
    const posted = rest.find((l) => RECENCY.test(l)) ?? null;
    const snippet = rest.find(
      (l) => l !== comp && l !== posted && !BADGE.test(l) && l.length > 40,
    ) ?? null;

    out.push({
      source: "indeed",
      ats_job_id: stableId("in", title, company, locParts.join(" - ")),
      title,
      company: clean(company),
      location: locParts.length ? clean(locParts.join(" - ")) : null,
      // Indeed's own footer: "Salaries estimated if unavailable." The scorer is
      // told to judge only STATED pay, so the provenance travels with the value.
      comp_text: comp ? `${comp} (per Indeed listing; may be an Indeed estimate)` : null,
      description: snippet,
      url,
      posted_hint: posted,
    });
  }
  return out;
}

/**
 * LinkedIn digest. Postings are separated by a dashed rule:
 *
 *   Plant Manager
 *   GTI Fabrication
 *   Buffalo, NY
 *   Fast growing                         <- optional badge
 *   View job: https://www.linkedin.com/comm/jobs/view/4422048854/?...
 *
 * The numeric id in the URL path is clean (unlike the query string), so
 * LinkedIn postings dedupe on LinkedIn's own id.
 */
export function parseLinkedInAlert(body: string): AlertPosting[] {
  const out: AlertPosting[] = [];
  const head = body.split(/\nSee all jobs on LinkedIn:/)[0];

  for (const raw of head.split(/\n-{10,}\n/)) {
    const m = raw.match(/View job:\s*(https:\/\/www\.linkedin\.com\/comm\/jobs\/view\/(\d+)\/\S*)/);
    if (!m) continue;

    const lines = raw.split("\n").map(clean).filter(Boolean)
      .filter((l) => !/^View job:/.test(l))
      // The first block carries the alert header; drop it.
      .filter((l) => !/^Your job alert for /i.test(l) && !/^\d+ new jobs match/i.test(l));

    const fields = lines.filter((l) => !BADGE.test(l) && !RECENCY.test(l));
    if (fields.length < 2) continue;

    const [title, company, location] = fields;
    out.push({
      source: "linkedin",
      ats_job_id: `li-${m[2]}`,
      title,
      company,
      location: location ?? null,
      comp_text: null,
      description: null,
      url: m[1],
      posted_hint: lines.find((l) => RECENCY.test(l)) ?? null,
    });
  }
  return out;
}

/** Route by sender. Unknown senders yield nothing rather than guessing. */
export function parseAlert(sender: string, body: string): AlertPosting[] {
  const s = sender.toLowerCase();
  if (s.includes("indeed.com")) return parseIndeedAlert(body);
  if (s.includes("linkedin.com")) return parseLinkedInAlert(body);
  return [];
}
