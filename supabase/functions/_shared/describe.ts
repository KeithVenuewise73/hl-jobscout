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

/** Money as an employer writes it: "$100,000 - $150,000", "$75K-$95K a year". */
const PAY_LINE =
  /\$\s?\d[\d,.]*\s?[kK]?(?:\s*(?:-|–|to)\s*\$?\s?\d[\d,.]*\s?[kK]?)?(?:\s*(?:per|\/|a)\s*(?:year|yr|hour|hr|annum))?/;

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

  // Fallback: the whole page as text. Coarse, and marked as such — a scorer
  // reading nav links and a cookie banner should know that is what it has.
  const text = clean(stripTags(html));
  if (text.length < 400) return { description: null, comp_text: null, via: "none" };
  return {
    description: text.slice(0, maxChars),
    comp_text: PAY_LINE.exec(text)?.[0]?.trim() ?? null,
    via: "text",
  };
}
