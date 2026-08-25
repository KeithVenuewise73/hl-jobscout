// Stage-1 filters. These run before a single token is spent, so a bug here is
// either wasted money (too loose) or a job you never see (too tight).
//
// Ported from score.py. Matching is WHOLE-WORD on purpose: the original
// substring list had "associate " with a trailing space, which never matches a
// title *ending* in "Associate" — so every warehouse-associate posting reached
// the model despite a filter existing to stop exactly that.

// Matched with a left word boundary only, so "operation" also catches
// "Operational Excellence". Tuned against Keith's actual career: the titles he
// has held (Market Manager at CRST, Operations Manager - Last Mile at RXO,
// Distribution Manager at Arctic Glacier) and the ones he should be shown.
export const TITLE_INCLUDE = [
  "operations", "operation", "plant", "production", "warehouse", "distribution",
  "logistics", "supply chain", "transportation", "fleet", "dispatch",
  "general manager", "site manager", "branch manager", "market manager",
  "facility", "facilities", "field service", "service manager", "terminal",
  "director", "president", "chief operating",
  "continuous improvement", "process improvement", "3pl", "last mile",
  "final mile", "delivery", "shipping", "receiving", "inventory",
  "route", "carrier", "depot",
];

// Short/ambiguous terms that need boundaries on BOTH sides — left-bounded
// "hub" matches "Hubbard", "vp" matches "VPN".
export const TITLE_INCLUDE_EXACT = ["vp", "coo", "gm", "hub", "dsd", "dc"];

// These beat the exclusion list. "Driver Manager" is a transportation
// management job, not a driving job, and the rule that kills "Delivery Driver"
// would otherwise kill it too. Same for "Associate Director", which is a senior
// title the "associate" rule was never aimed at.
export const TITLE_RESCUE = [
  "driver manager", "driver supervisor", "driver lead",
  "associate director", "associate vice president",
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

const EXCLUDE_RE = new RegExp(`\\b(?:${TITLE_EXCLUDE.map(esc).join("|")})\\b`, "i");
const INCLUDE_RE = new RegExp(`\\b(?:${TITLE_INCLUDE.map(esc).join("|")})`, "i");
const INCLUDE_EXACT_RE = new RegExp(`\\b(?:${TITLE_INCLUDE_EXACT.map(esc).join("|")})\\b`, "i");
const RESCUE_RE = new RegExp(`\\b(?:${TITLE_RESCUE.map(esc).join("|")})\\b`, "i");

export function titleOk(t: string | null | undefined): boolean {
  const s = t ?? "";
  if (RESCUE_RE.test(s)) return true;          // rescue beats exclude
  if (EXCLUDE_RE.test(s)) return false;
  return INCLUDE_RE.test(s) || INCLUDE_EXACT_RE.test(s);
}

export function locationOk(loc: string | null | undefined): boolean {
  // Unknown location is not a reason to spend nothing — let the model see it.
  if (!loc) return true;
  const l = loc.toLowerCase();
  return LOCATION_OK.some((x) => l.includes(x));
}
