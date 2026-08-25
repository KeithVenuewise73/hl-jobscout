// Stage-1 filters. These run before a single token is spent, so a bug here is
// either wasted money (too loose) or a job you never see (too tight).
//
// Ported from score.py. Matching is WHOLE-WORD on purpose: the original
// substring list had "associate " with a trailing space, which never matches a
// title *ending* in "Associate" — so every warehouse-associate posting reached
// the model despite a filter existing to stop exactly that.

export const TITLE_INCLUDE = [
  "operations", "operation", "plant", "production", "warehouse", "distribution",
  "logistics", "supply chain", "transportation", "fleet", "dispatch",
  "general manager", "site manager", "branch manager", "facility", "facilities",
  "field service", "service manager", "terminal", "director", "vp",
  "continuous improvement", "process improvement", "3pl", "last mile",
  "final mile", "delivery", "shipping", "receiving", "inventory",
];

export const TITLE_EXCLUDE = [
  "intern", "internship", "associate", "clerk", "driver", "cdl",
  "technician", "engineer i", "software", "nurse", "rn", "physician",
  "sales representative", "cashier", "part-time", "part time", "seasonal",
  "loader", "unloader", "picker", "packer", "custodian", "janitor",
  "entry level", "apprentice", "co-op",
];

// Buffalo/WNY commutable, plus remote.
export const LOCATION_OK = [
  "buffalo", "amherst", "cheektowaga", "tonawanda", "lancaster", "depew",
  "west seneca", "hamburg", "orchard park", "lackawanna", "niagara",
  "lockport", "batavia", "rochester", "olean", "jamestown", "dunkirk",
  "fredonia", "wny", "western new york", "remote", "erie county",
  "new york", " ny", "ny,", "ny ",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Exclusions are bounded on both sides ("associate" must not match
// "Associated"). Inclusions are bounded on the left only, so "operation"
// still catches "Operational Excellence".
const EXCLUDE_RE = new RegExp(`\\b(?:${TITLE_EXCLUDE.map(esc).join("|")})\\b`, "i");
const INCLUDE_RE = new RegExp(`\\b(?:${TITLE_INCLUDE.map(esc).join("|")})`, "i");

export function titleOk(t: string | null | undefined): boolean {
  const s = t ?? "";
  if (EXCLUDE_RE.test(s)) return false;
  return INCLUDE_RE.test(s);
}

export function locationOk(loc: string | null | undefined): boolean {
  // Unknown location is not a reason to spend nothing — let the model see it.
  if (!loc) return true;
  const l = loc.toLowerCase();
  return LOCATION_OK.some((x) => l.includes(x));
}
