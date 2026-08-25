// Pull a posting's real description off the employer's own site.
//
// Why this exists: the alert emails carry title, company and location and
// nothing else. The scorer caps a description-less posting at 55 and says so,
// which is honest but useless for ranking — every real candidate lands in a
// 40-55 band and the ordering inside it is guesswork about job titles.
//
// The fetch is INJECTED so the extraction is testable offline, same as the
// rest of the cores here.

/**
 * Sources we will not fetch, on purpose.
 *
 * LinkedIn's terms prohibit automated access and Indeed answers scrapers with
 * a Cloudflare 403 — that is precisely why JobScout reads Keith's own alert
 * EMAILS instead. Those emails hand us a linkedin.com link for him to click,
 * so without this guard the obvious next step is to fetch the very URL the
 * whole email-parsing design exists to avoid. The rule belongs in code, not in
 * a comment someone has to remember.
 */
const BLOCKED_HOSTS = [
  "linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com",
];

export function blockedSource(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "malformed url";
  }
  const hit = BLOCKED_HOSTS.find((b) => host === b || host.endsWith(`.${b}`));
  return hit ? `${hit} is not fetched — read the alert email instead` : null;
}

export interface Extracted {
  description: string | null;
  comp_text: string | null;
  /** How we got it, for the audit trail. */
  via: "json-ld" | "text" | "none";
}

const stripTags = (s: string) =>
  s.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

// Page furniture. Taking a whole page as text yields "Skip to Main Content /
// Toggle navigation / Home / Search Jobs / Log In" before a word of the job —
// which the first real run against a university careers portal produced
// exactly. Nav text is not neutral noise: the scorer reads it as part of the
// role.
const CHROME =
  /<(nav|header|footer|aside|form|select|button|noscript)\b[\s\S]*?<\/\1>/gi;

/**
 * Narrow to the part of the page that is the posting.
 *
 * <main> / <article> / role="main" are the semantics that say "this is the
 * content"; most ATS portals and careers sites set at least one. When none is
 * present we keep the whole body and only drop the furniture — a coarser
 * answer, but never a worse one than not trying.
 */
export function mainContent(html: string): string {
  const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(CHROME, " ");
  for (const re of [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<[a-z]+[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[a-z]+>/i,
  ]) {
    const m = re.exec(body);
    // A <main> holding almost nothing means the real content is elsewhere
    // (a single-page app shell, say), so fall through rather than trust it.
    if (m && stripTags(m[1]).replace(/\s+/g, " ").trim().length > 300) return m[1];
  }
  return body;
}

const entities: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&ndash;": "-", "&mdash;": "-", "&rsquo;": "'",
};

export const clean = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => entities[m.toLowerCase()] ?? " ")
    .replace(/[ \t ]+/g, " ")
    // Trim each line but KEEP blank ones. Collapsing /\s*\n\s*/ instead — the
    // obvious way to write this — eats every blank line, so the paragraph and
    // bullet structure a job description carries its meaning in arrives as one
    // undifferentiated wall of text.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Money as an employer writes it: "$100,000 - $150,000", "$75K-$95K a year".
 *
 * Every part of this is a plausibility gate, and it is here because the loose
 * version wrote "$30" into a posting's pay field off a university careers page
 * — where it came from a phone extension, a fee, anything. That is not a
 * cosmetic error: the scorer is told to cap a job at 25 when stated pay is
 * below the floor, so a stray "$30" silently converts a real Director role
 * into a rejection.
 *
 * A number only counts as pay when it says so:
 *   - four figures or more ($1,000+), or
 *   - a K/M suffix ($95K), or
 *   - an explicit unit ("$30 per hour", "$30/hr").
 * A bare "$30" matches none of these and is ignored.
 */
const AMOUNT = String.raw`\$\s?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?[kKmM]|\d{4,}(?:\.\d+)?)`;
const UNIT = String.raw`\s*(?:per\s+|\/|an?\s+)(?:year|yr|hour|hr|annum|month|week)`;
const SMALL = String.raw`\$\s?\d{1,3}(?:\.\d+)?`;
const PAY_LINE = new RegExp(
  // a qualifying amount, optionally ranged, optionally with a unit
  `(?:${AMOUNT}(?:\\s*(?:-|–|to)\\s*(?:${AMOUNT}|\\$?\\s?\\d[\\d,.]*\\s?[kKmM]?))?(?:${UNIT})?` +
    // or a small number that EARNS it by naming its unit ("$30 per hour")
    `|${SMALL}(?:\\s*(?:-|–|to)\\s*${SMALL})?${UNIT})`,
);

function fromBaseSalary(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const b = node as Record<string, unknown>;
  const v = (b.value ?? b) as Record<string, unknown>;
  const min = v.minValue ?? v.value;
  const max = v.maxValue;
  const unit = typeof v.unitText === "string" ? v.unitText.toLowerCase() : "";
  const per = unit === "year" ? "/yr" : unit === "hour" ? "/hr" : "";
  if (min == null) return null;
  const n = (x: unknown) => Number(x).toLocaleString("en-US");
  return max != null && max !== min
    ? `$${n(min)} - $${n(max)}${per}`
    : `$${n(min)}${per}`;
}

/**
 * schema.org JobPosting first.
 *
 * This is not a scraping trick — employers publish it deliberately so Google
 * for Jobs can index them. It is the closest thing to an API a careers page
 * has, it survives redesigns that break every CSS selector, and it gives us
 * the salary as a NUMBER rather than a sentence to guess at.
 */
export function extract(html: string, maxChars = 12_000): Extracted {
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // A malformed block is not a reason to abandon the page.
    }
    // JobPosting may sit at the top level, in an @graph, or in a bare array.
    const nodes: unknown[] = Array.isArray(parsed)
      ? parsed
      : [parsed, ...((parsed as { "@graph"?: unknown[] })?.["@graph"] ?? [])];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const t = o["@type"];
      const isJob = t === "JobPosting" ||
        (Array.isArray(t) && t.includes("JobPosting"));
      if (!isJob || typeof o.description !== "string") continue;
      const desc = clean(stripTags(o.description));
      if (desc.length < 100) continue; // a stub, not a description
      return {
        description: desc.slice(0, maxChars),
        comp_text: fromBaseSalary(o.baseSalary) ??
          (PAY_LINE.exec(desc)?.[0]?.trim() ?? null),
        via: "json-ld",
      };
    }
  }

  // Fallback: the page's main content as text, with the furniture removed.
  // Coarser than JobPosting and marked as such, so a caller can decide whether
  // to trust it — jobscout-describe refuses to save it unless told to.
  const text = clean(stripTags(mainContent(html)));
  if (text.length < 400) return { description: null, comp_text: null, via: "none" };
  return {
    description: text.slice(0, maxChars),
    comp_text: PAY_LINE.exec(text)?.[0]?.trim() ?? null,
    via: "text",
  };
}
