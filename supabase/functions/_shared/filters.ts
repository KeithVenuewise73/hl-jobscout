// Stage-1 filters. These run before a single token is spent, so a bug here is
// either wasted money (too loose) or a job you never see (too tight).
//
// Ported from score.py. Matching is WHOLE-WORD on purpose: the original
// substring list had "associate " with a trailing space, which never matches a
// title *ending* in "Associate" — so every warehouse-associate posting reached
// the model despite a filter existing to stop exactly that.

import { DEFAULT_RADIUS_MILES, withinRadius } from "./geo.ts";

export { DEFAULT_RADIUS_MILES, withinRadius };

// Matched with a left word boundary only, so "operation" also catches
// "Operational Excellence". Tuned against Keith's actual career: the titles he
// has held (Market Manager at CRST, Operations Manager - Last Mile at RXO,
// Distribution Manager at Arctic Glacier) and the ones he should be shown.
export const TITLE_INCLUDE = [
  "operations", "operation", "plant", "production", "warehouse", "distribution",
  "logistics", "supply chain", "transportation", "fleet", "dispatch",
  "general manager", "site manager", "branch manager", "market manager",
  "area manager", "regional manager", "district manager",
  // Target level: Senior Manager / Director of Operations and up.
  "senior manager", "sr manager", "sr. manager", "head of", "chief",
  "vice president", "senior director", "executive director",
  "facility", "facilities", "field service", "service manager", "terminal",
  "director", "president", "chief operating",
  "continuous improvement", "process improvement", "3pl", "last mile",
  "final mile", "delivery", "shipping", "receiving", "inventory",
  "route", "carrier", "depot",
];

// Short/ambiguous terms that need boundaries on BOTH sides — left-bounded
// "hub" matches "Hubbard", "vp" matches "VPN".
// "Mgr US Brokerage" and "Ops Director" are real postings that died on the
// spelled-out list. Bounded on both sides so they cannot match inside a word.
export const TITLE_INCLUDE_EXACT = [
  "vp", "coo", "gm", "hub", "dsd", "dc", "mgr", "ops", "svp", "avp",
];

// These beat the exclusion list. "Driver Manager" is a transportation
// management job, not a driving job, and the rule that kills "Delivery Driver"
// would otherwise kill it too. Same for "Associate Director", which is a senior
// title the "associate" rule was never aimed at.
export const TITLE_RESCUE = [
  "driver manager", "driver supervisor", "driver lead",
  "associate director", "associate vice president",
];

export const TITLE_EXCLUDE = [
  // Unambiguously below the target level. Anything arguable — a plain
  // "Manager", a "Supervisor" at a real industrial site — is left IN and judged
  // by the model, which reads scope from the description. A keyword cannot tell
  // a 80-person DC manager from a shift lead; the posting can.
  // Warehouse-floor roles. The include list carries broad function words
  // ("warehouse", "shipping", "inventory") that are right in a manager title
  // and wrong on their own — one real Indeed digest of 11 "distribution jobs"
  // was 11 floor roles at $17-25/hour, and three of them bought model calls.
  "warehouse worker", "warehouse associate", "warehouse clerk",
  "warehouse lead", "warehouse team lead", "dock lead", "line lead",
  "material handler", "load operator", "forklift", "order selector",
  "1st shift", "2nd shift", "3rd shift", "stockroom", "stocker",
  "assistant manager", "assistant director", "associate manager",
  "shift supervisor", "shift lead", "shift manager", "team lead",
  "crew lead", "crew leader", "trainee", "management trainee",
  "intern", "internship", "associate", "clerk", "driver", "cdl",
  "technician", "engineer i", "software", "nurse", "rn", "physician",
  "sales representative", "cashier", "part-time", "part time", "seasonal",
  "loader", "unloader", "picker", "packer", "custodian", "janitor",
  "entry level", "apprentice", "co-op",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EXCLUDE_RE = new RegExp(`\\b(?:${TITLE_EXCLUDE.map(esc).join("|")})\\b`, "i");
const INCLUDE_RE = new RegExp(`\\b(?:${TITLE_INCLUDE.map(esc).join("|")})`, "i");
const INCLUDE_EXACT_RE = new RegExp(`\\b(?:${TITLE_INCLUDE_EXACT.map(esc).join("|")})\\b`, "i");
const RESCUE_RE = new RegExp(`\\b(?:${TITLE_RESCUE.map(esc).join("|")})\\b`, "i");

/**
 * A title must name a LEVEL, not just a function.
 *
 * The include list carries broad function words — "warehouse", "shipping",
 * "logistics", "inventory" — which are right inside "Warehouse Manager" and
 * wrong on their own. One real Indeed digest of eleven "distribution jobs" was
 * eleven floor roles at $17-25/hour, and "WAREHOUSE OPERATIONS", "Shipping and
 * Receiving" and "Logistics Customer Service Representative" all bought model
 * calls off those function words alone.
 *
 * Chasing that with more exclusions is endless. Requiring a level word is one
 * rule, and it is the actual target: Senior Manager / Director and up.
 */
const SENIORITY_RE =
  /\b(manager|mgr|managing|director|head|chief|officer|president|vp|svp|avp|coo|gm|superintendent|supervisor|executive|principal|lead|leader)\b/i;

// "lead" counts as a level word above, because "Operational Excellence Lead"
// and "Continuous Improvement Lead" are plausible fits. The junior leads are
// caught by TITLE_EXCLUDE, which runs first — an inclusion error costs a model
// call, an exclusion error costs an opportunity.

export function titleOk(t: string | null | undefined): boolean {
  const s = t ?? "";
  if (RESCUE_RE.test(s)) return true;          // rescue beats exclude
  if (EXCLUDE_RE.test(s)) return false;
  if (!SENIORITY_RE.test(s)) return false;     // function without a level
  return INCLUDE_RE.test(s) || INCLUDE_EXACT_RE.test(s);
}

/**
 * Radius gate. Delegates to geo.ts, which measures real distance from Buffalo.
 *
 * The list this replaced contained "new york", " ny" and "ny," — so every
 * posting in the state passed, Brooklyn and Yonkers included. It was a filter
 * that filtered nothing.
 */
export function locationOk(
  loc: string | null | undefined,
  radiusMiles = DEFAULT_RADIUS_MILES,
): boolean {
  return withinRadius(loc, radiusMiles).ok;
}
