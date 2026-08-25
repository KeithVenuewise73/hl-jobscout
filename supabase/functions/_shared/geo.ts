// Is this posting inside the commute radius?
//
// Two rewrites got here, and both failures are worth remembering.
//
// The starter answered this with a substring allow-list containing "new york",
// " ny" and "ny,". Every posting in the state matched — Brooklyn, Yonkers,
// Albany — so the one free filter guarding the model bill admitted the
// 290-mile-away postings it existed to stop.
//
// The replacement was a hand-typed table of ~50 towns scanned by regex. Better,
// but it had the same shape of flaw: any town not on the list fell through to
// the "unresolved" pass, and the entry for "new york" swallowed "Western New
// York" and filed a local job as 292 miles out.
//
// Now the gazetteer is GENERATED from USPS ZIP data (tools/build_gazetteer.py),
// resolution is a map lookup rather than thousands of regexes, and a posting
// that carries a ZIP code resolves exactly rather than by name.

import { PLACE_COORDS, ZIP_COORDS } from "./gazetteer.ts";

export const ORIGIN = { name: "Buffalo, NY", lat: 42.8864, lon: -78.8784 };
export const DEFAULT_RADIUS_MILES = 50;

/** Great-circle distance in miles. */
export function distanceMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const milesFromOrigin = (lat: number, lon: number) =>
  distanceMiles(ORIGIN, { lat, lon });

/**
 * Regional phrasings an ATS prints that no postal dataset contains.
 *
 * These must be tested BEFORE the city lookup: "Western New York" contains
 * "New York", and matching that first is exactly how a Buffalo job once got
 * filed as 292 miles away.
 */
const REGIONS: [RegExp, [number, number]][] = [
  [/\bwestern new york\b|\bw\.?n\.?y\.?\b/i, [42.8864, -78.8784]],
  [/\bbuffalo[- ]niagara\b/i, [42.8864, -78.8784]],
  [/\berie county\b/i, [42.8864, -78.8784]],
  [/\bniagara county\b/i, [43.1706, -78.6903]],
  [/\bsouthern tier\b/i, [42.0970, -79.2353]],
  [/\bfinger lakes\b/i, [42.8, -77.0]],
  [/\bcapital region\b/i, [42.6526, -73.7562]],
  [/\bhudson valley\b/i, [41.7004, -73.9209]],
  [/\blong island\b/i, [40.7891, -73.1350]],
];

const REMOTE = /\b(remote|work from home|wfh|virtual|telecommute)\b/i;

// Every state except NY and PA — the only two with any land inside a plausible
// commute of Buffalo. Naming one is a definite answer, so "Dallas, TX" is
// excluded rather than riding the unresolved fallback into a paid model call.
//
// This only fires below FAR_STATE_MAX_RADIUS. Ohio's nearest point is roughly
// 140 miles out, so it belongs here at 50 miles and would NOT at 200 — rather
// than encode that per state, the rule steps aside once the radius is wide
// enough for the claim to stop being true, and the model judges instead.
const FAR_STATE =
  /(?:^|[,(\s])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NC|ND|OH|OK|OR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:[,).\s]|$)/;
const FAR_STATE_MAX_RADIUS = 100;

// Canadian provinces, minus Ontario. Ontario is genuinely commutable — Fort
// Erie is across the bridge — but a LinkedIn alert surfaced a Montreal role
// that sailed through as "unresolved" because QC was in no list at all.
// LinkedIn writes state-level postings as "Virginia, United States", and the
// code list above only knows "VA". Every such posting therefore rode the
// unresolved fallback into a paid model call — and LinkedIn uses this form a
// lot. Spelled-out names, minus New York and Pennsylvania.
//
// This is only reached after ZIP, region and city lookup have all failed, which
// is what makes it safe: "Indiana, PA" and "Columbus, Ohio" are resolved by the
// city table before they can be mistaken for a bare state.
const FAR_STATE_NAME = new RegExp(
  "\\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware" +
    "|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky" +
    "|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi" +
    "|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico" +
    "|north carolina|north dakota|ohio|oklahoma|oregon|rhode island" +
    "|south carolina|south dakota|tennessee|texas|utah|vermont|virginia" +
    "|washington|west virginia|wisconsin|wyoming|district of columbia)\\b",
  "i",
);

const FAR_PROVINCE =
  /(?:^|[,(\s])(QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU|QUEBEC|MONTREAL|VANCOUVER|CALGARY|EDMONTON|WINNIPEG|HALIFAX|OTTAWA)(?:[,).\s]|$)/;

const ZIP = /\b(\d{5})(?:-\d{4})?\b/;
// "Buffalo, NY" / "Buffalo, New York" / "Amherst NY 14221"
const CITY_STATE = /([A-Za-z][A-Za-z.'\- ]{1,40}?)[,\s]+(?:([A-Z]{2})|(New York|Pennsylvania|Ohio))\b/;

const STATE_WORD: Record<string, string> = {
  "new york": "NY",
  "pennsylvania": "PA",
  "ohio": "OH",
};

export type Reason = "remote" | "zip" | "city" | "region" | "far_state" | "unresolved";

export interface RadiusResult {
  ok: boolean;
  reason: Reason;
  /** What we matched on, for the audit trail. */
  matched?: string;
  miles?: number;
}

const verdict = (
  lat: number,
  lon: number,
  reason: Reason,
  matched: string,
  radiusMiles: number,
): RadiusResult => {
  const m = milesFromOrigin(lat, lon);
  return { ok: m <= radiusMiles, reason, matched, miles: Math.round(m) };
};

/**
 * Resolve a free-text ATS location string against the radius.
 *
 * Order matters and is deliberate: ZIP is exact, so it wins; regions are
 * checked before cities because their names contain city names; a bare far
 * state is a real answer; and only then do we give up.
 *
 * An unresolved location returns ok:true ON PURPOSE. An unknown place is not a
 * reason to spend nothing — the model can judge it with the posting in front
 * of it. That fallback is why far places are in the gazetteer at all: they have
 * to be present to be excluded.
 */
export function withinRadius(
  location: string | null | undefined,
  radiusMiles = DEFAULT_RADIUS_MILES,
): RadiusResult {
  if (!location || !location.trim()) return { ok: true, reason: "unresolved" };
  const raw = location.trim();

  if (REMOTE.test(raw)) return { ok: true, reason: "remote", matched: "remote" };

  // 1. A ZIP is unambiguous — no name collisions, no alternate spellings.
  const zm = ZIP.exec(raw);
  if (zm) {
    const pt = ZIP_COORDS[zm[1]];
    if (pt) return verdict(pt[0], pt[1], "zip", zm[1], radiusMiles);
  }

  // 2. Regions, before cities: "Western New York" contains "New York".
  for (const [re, pt] of REGIONS) {
    const rm = re.exec(raw);
    if (rm) return verdict(pt[0], pt[1], "region", rm[0], radiusMiles);
  }

  // 3. City + state, from real postal data including USPS alternate names.
  const cm = CITY_STATE.exec(raw);
  if (cm) {
    const city = cm[1].trim().toLowerCase().replace(/\s+/g, " ");
    const st = cm[2] ?? STATE_WORD[(cm[3] ?? "").toLowerCase()];
    if (st) {
      const pt = PLACE_COORDS[`${city}|${st}`];
      if (pt) return verdict(pt[0], pt[1], "city", `${city}, ${st}`, radiusMiles);
    }
  }

  // 4. A named far state or province settles it without a city we recognize.
  if (radiusMiles <= FAR_STATE_MAX_RADIUS) {
    const up = raw.toUpperCase();
    const fm = FAR_STATE.exec(up) ?? FAR_PROVINCE.exec(up);
    if (fm) return { ok: false, reason: "far_state", matched: fm[1] };
    const nm = FAR_STATE_NAME.exec(raw);
    if (nm) return { ok: false, reason: "far_state", matched: nm[1] };
  }

  return { ok: true, reason: "unresolved" };
}
