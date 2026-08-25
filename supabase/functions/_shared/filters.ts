// Location filters, and the stage-1 gate that combines them with the title
// rules. The title rules themselves live in titles.ts, which deliberately does
// NOT reach geo.ts and its generated gazetteer — see the note there.

import { DEFAULT_RADIUS_MILES, withinRadius } from "./geo.ts";
import { titleOk } from "./titles.ts";

export { DEFAULT_RADIUS_MILES, titleOk, withinRadius };
export {
  TITLE_EXCLUDE, TITLE_INCLUDE, TITLE_INCLUDE_EXACT, TITLE_RESCUE,
} from "./titles.ts";

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

export interface FilterableJob {
  title: string;
  location?: string | null;
}

// ---- location independence -------------------------------------------------
//
// The radius gate answers "can he drive there". That is the wrong question for
// a whole class of roles he is qualified for and open to.
//
// Measured, not assumed: one national digest carried six Director/Head-level
// postings and the radius gate dropped every one — including a role whose own
// title said "Remote", because LinkedIn had filed it under the employer's
// head-office city. An exclusion error costs an opportunity permanently and
// silently; an inclusion error costs a cent or two and gets a real verdict
// from the model. So these signals ADMIT, and the scorer decides.

/** The title says remote even when the location field names a city. */
const REMOTE_TITLE =
  /\b(remote|virtual|work from home|wfh|telecommut\w*|home[- ]based|anywhere)\b/i;

/**
 * Scope that makes a role location-independent in practice.
 *
 * A "Director, North America Logistics" is not a commute — it is a territory,
 * usually run from anywhere with travel. The employer's address on the posting
 * is where the company is, not where the work happens. Same for national,
 * global and multi-site titles at this level.
 */
const TRAVELLING_SCOPE =
  /\b(north america|nationwide|national|global|international|multi[- ]?(site|unit|state)|field (operations|service|based)|travel(l?ing)?|territory|division(al)?)\b/i;

export type PlaceReason =
  | "in_radius"
  | "remote_title"
  | "travelling_scope"
  | "out_of_area";

export interface PlaceVerdict {
  ok: boolean;
  reason: PlaceReason;
}

export interface EligibilityOptions {
  radiusMiles?: number;
  /**
   * Admit remote and territory roles that sit outside the radius. Off by
   * default so the gate stays honest for anyone who wants a commute only;
   * Keith has it ON — it is the difference between a metro and a country.
   */
  locationIndependent?: boolean;
}

/**
 * Where a posting stands, and why. The reason is returned rather than a bare
 * boolean so a caller can report WHY a job was admitted — a Dallas address
 * admitted on a "North America" title is a different fact from one in Amherst.
 */
export function placeOk(
  job: FilterableJob,
  opts: EligibilityOptions = {},
): PlaceVerdict {
  const radiusMiles = opts.radiusMiles ?? DEFAULT_RADIUS_MILES;
  if (withinRadius(job.location, radiusMiles).ok) {
    return { ok: true, reason: "in_radius" };
  }
  if (opts.locationIndependent) {
    // The title is checked, not just the location field. That is the whole
    // point: the posting that got away said "Remote" in its own title.
    if (REMOTE_TITLE.test(job.title)) return { ok: true, reason: "remote_title" };
    if (TRAVELLING_SCOPE.test(job.title)) {
      return { ok: true, reason: "travelling_scope" };
    }
  }
  return { ok: false, reason: "out_of_area" };
}

/**
 * Stage 1: the free filters, applied before a single token is spent.
 *
 * This lives with the filters rather than in the scorer on purpose. Scoring
 * runs as an edge function, and importing this pulled in geo.ts and its
 * generated 130KB+ postal gazetteer — a lot of deploy weight, and a lot of
 * cold-start parsing, for a decision better made once when a posting is
 * written than repeatedly when it is scored.
 */
export function eligible<T extends FilterableJob>(
  jobs: T[],
  opts: EligibilityOptions | number = {},
): T[] {
  // A bare number still means "radius", so older callers keep working.
  const o = typeof opts === "number" ? { radiusMiles: opts } : opts;
  return jobs.filter((j) => titleOk(j.title) && placeOk(j, o).ok);
}
