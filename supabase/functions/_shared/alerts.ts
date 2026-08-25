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
    "|this company is actively hiring|fast growing|promoted|viewed|top applicant" +
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
  const LINK = /^https:\/\/www\.indeed\.com\/(?:rc\/clk|pagead\/clk)/;

  // Each posting ENDS at its Indeed link, so splitting there puts one posting
  // at the tail of each block, paired with the link that follows it.
  const blocks = body.split(/\n(?=https:\/\/www\.indeed\.com\/(?:rc\/clk|pagead\/clk))/);

  for (let i = 0; i < blocks.length - 1; i++) {
    const url = (blocks[i + 1].match(/^(https:\/\/www\.indeed\.com\/\S+)/) ?? [])[1] ?? null;

    let lines = blocks[i].split("\n").map(clean).filter(Boolean);
    // Drop the previous posting's link, which leads every block after the first.
    if (lines.length && LINK.test(lines[0])) lines = lines.slice(1);
    // The first block is preceded by the digest header. Strip it by its
    // trailing "See matching results" line where present, and defensively by
    // shape where it is not — a header read as a posting both invents a job
    // and swallows the real first one.
    const hdr = lines.findIndex((l) => /^See matching results on Indeed:/i.test(l));
    if (hdr >= 0) lines = lines.slice(hdr + 1);
    while (
      lines.length &&
      /^(indeed job alert|jobs \d+-\d+ of |\d+ new .*\bjobs?\b.* in )/i.test(lines[0])
    ) lines = lines.slice(1);
    if (lines.length < 2) continue;

    // Read FORWARD from the top of the posting. Scanning backwards for the
    // "Company - Location" line looked reasonable and was wrong: descriptions
    // contain hyphens too ("(4:00 PM - 12:00 AM)", "Williamsville, NY - ..."),
    // so the scan landed in the snippet and read the badge line above it
    // ("Easily apply") as the job title.
    const title = lines[0];
    const coLine = lines[1];
    if (!title || title.length > 200 || BADGE.test(title) || PAY.test(title)) continue;
    if (!coLine || BADGE.test(coLine)) continue;

    const dash = coLine.indexOf(" - ");
    const company = dash >= 0 ? coLine.slice(0, dash) : coLine;
    const location = dash >= 0 ? coLine.slice(dash + 3) : null;

    const rest = lines.slice(2);
    const comp = rest.find((l) => PAY.test(l)) ?? null;
    const posted = rest.find((l) => RECENCY.test(l)) ?? null;
    const snippet = rest.find(
      (l) => l !== comp && l !== posted && !BADGE.test(l) && l.length > 40,
    ) ?? null;

    out.push({
      source: "indeed",
      ats_job_id: stableId("in", title, company, location),
      title,
      company: clean(company),
      location: location ? clean(location) : null,
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

  const blocks = head.split(/\n-{10,}\n/);
  for (let b = 0; b < blocks.length; b++) {
    const raw = blocks[b];
    const m = raw.match(/View job:\s*(https:\/\/www\.linkedin\.com\/comm\/jobs\/view\/(\d+)\/\S*)/);
    if (!m) continue;

    let lines = raw.split("\n").map(clean).filter(Boolean)
      .filter((l) => !/^View job:/.test(l));

    // Only the FIRST block carries the alert header, so header stripping is
    // confined to it — a later posting can never lose its title to a phrase
    // that happens to look like preamble.
    //
    // Within that block, drop everything up to and including the last header
    // line. Matching the count was the bug: the Buffalo digests lead "10 new
    // jobs match your preferences.", but a national one leads "New jobs match
    // your preferences." with no count. The count-anchored filter missed it, so
    // the header became the title, the title became the company, and the
    // digest's first real posting vanished with no trace in any report.
    if (b === 0) {
      const isHeader = (l: string) =>
        /^Your job alert for /i.test(l) || /\bmatch(es)? your preferences\b/i.test(l);
      let last = -1;
      for (let i = 0; i < lines.length; i++) if (isHeader(lines[i])) last = i;
      if (last >= 0) lines = lines.slice(last + 1);
    }

    const fields = lines.filter((l) => !BADGE.test(l) && !RECENCY.test(l));
    if (fields.length < 2) continue;

    // Read FORWARD. LinkedIn prints badges BELOW the location, so an
    // unrecognized badge is harmless here — it lands after the three fields we
    // want. Reading backwards to dodge the header would have broken on exactly
    // that, which is why the header is handled above instead.
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
