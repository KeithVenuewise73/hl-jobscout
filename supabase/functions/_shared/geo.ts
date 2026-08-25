// Is this posting inside the commute radius?
//
// The starter answered this with a substring list containing "new york", " ny"
// and "ny,". Every posting in New York State matched it — Brooklyn, Yonkers,
// Albany, Syracuse and Long Island City all passed a filter whose entire job
// was keeping them out. The "free" stage-1 gate that protects the model bill
// was letting through the 370-mile-away postings it existed to stop.
//
// So: real coordinates, real distance, one number to tune.

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

/**
 * Places an ATS is likely to name around here, plus the NY cities that must be
 * positively excluded rather than merely unmatched.
 *
 * An unrecognized location is allowed through (see withinRadius), so a far city
 * that is absent from this table would slip past on the fallback. That is why
 * the downstate and central-NY entries are here at all.
 *
 * Only places whose coordinates are known with confidence are listed. A missing
 * town costs one model call; a wrong coordinate silently mis-files a job.
 */
export const PLACES: Record<string, { lat: number; lon: number }> = {
  // --- Erie County ---
  "buffalo": { lat: 42.8864, lon: -78.8784 },
  "amherst": { lat: 42.9784, lon: -78.7998 },
  "cheektowaga": { lat: 42.9034, lon: -78.7548 },
  "north tonawanda": { lat: 43.0387, lon: -78.8642 },
  "tonawanda": { lat: 43.0203, lon: -78.8803 },
  "kenmore": { lat: 42.9656, lon: -78.8703 },
  "lancaster": { lat: 42.9006, lon: -78.6703 },
  "depew": { lat: 42.9042, lon: -78.6920 },
  "west seneca": { lat: 42.8500, lon: -78.7998 },
  "hamburg": { lat: 42.7159, lon: -78.8295 },
  "orchard park": { lat: 42.7675, lon: -78.7439 },
  "lackawanna": { lat: 42.8256, lon: -78.8236 },
  "east aurora": { lat: 42.7681, lon: -78.6136 },
  "williamsville": { lat: 42.9639, lon: -78.7378 },
  "getzville": { lat: 43.0006, lon: -78.7597 },
  "clarence": { lat: 42.9834, lon: -78.5978 },
  "elma": { lat: 42.8434, lon: -78.6403 },
  "springville": { lat: 42.5081, lon: -78.6672 },
  "akron": { lat: 43.0206, lon: -78.4964 },
  "grand island": { lat: 43.0334, lon: -78.9622 },
  "eden": { lat: 42.6528, lon: -78.8992 },
  "blasdell": { lat: 42.7967, lon: -78.8264 },

  // --- Niagara County ---
  "niagara falls": { lat: 43.0962, lon: -79.0377 },
  "lockport": { lat: 43.1706, lon: -78.6903 },

  // --- Genesee / Chautauqua / Cattaraugus ---
  "batavia": { lat: 42.9981, lon: -78.1875 },
  "dunkirk": { lat: 42.4795, lon: -79.3339 },
  "fredonia": { lat: 42.4401, lon: -79.3317 },
  "franklinville": { lat: 42.3384, lon: -78.4581 },
  "olean": { lat: 42.0778, lon: -78.4297 },
  "jamestown": { lat: 42.0970, lon: -79.2353 },

  // --- Rochester corridor: judged on distance, not assumed either way ---
  "rochester": { lat: 43.1566, lon: -77.6088 },
  "fairport": { lat: 43.0987, lon: -77.4425 },
  "farmington": { lat: 42.9895, lon: -77.3200 },
  "macedon": { lat: 43.0692, lon: -77.3005 },

  // Regional phrasings an ATS actually uses. These MUST be listed, and must be
  // longer than "new york", or the longest-name-first ordering resolves
  // "Western New York" to New York City and drops it as 292 miles away.
  "western new york": { lat: 42.8864, lon: -78.8784 },
  "wny": { lat: 42.8864, lon: -78.8784 },
  "buffalo niagara": { lat: 42.8864, lon: -78.8784 },
  "erie county": { lat: 42.8864, lon: -78.8784 },
  "niagara county": { lat: 43.1706, lon: -78.6903 },

  // --- Far NY: named so they cannot slip past the unresolved fallback ---
  "new york city": { lat: 40.7128, lon: -74.0060 },
  "new york": { lat: 40.7128, lon: -74.0060 },
  "nyc": { lat: 40.7128, lon: -74.0060 },
  "manhattan": { lat: 40.7831, lon: -73.9712 },
  "brooklyn": { lat: 40.6782, lon: -73.9442 },
  "queens": { lat: 40.7282, lon: -73.7949 },
  "bronx": { lat: 40.8448, lon: -73.8648 },
  "staten island": { lat: 40.5795, lon: -74.1502 },
  "long island city": { lat: 40.7447, lon: -73.9485 },
  "yonkers": { lat: 40.9312, lon: -73.8988 },
  "white plains": { lat: 41.0340, lon: -73.7629 },
  "albany": { lat: 42.6526, lon: -73.7562 },
  "syracuse": { lat: 43.0481, lon: -76.1474 },
  "binghamton": { lat: 42.0987, lon: -75.9180 },
  "utica": { lat: 43.1009, lon: -75.2327 },
  "watertown": { lat: 43.9748, lon: -75.9108 },
  "adams": { lat: 43.8095, lon: -76.0244 },
  "ithaca": { lat: 42.4440, lon: -76.5019 },
  "elmira": { lat: 42.0898, lon: -76.8077 },
  "poughkeepsie": { lat: 41.7004, lon: -73.9209 },

  // --- Just over the state line ---
  "erie": { lat: 42.1292, lon: -80.0851 },
};

const REMOTE = /\b(remote|work from home|wfh|anywhere|virtual)\b/i;

// Every US state except the two that can contain a 50-mile-from-Buffalo
// address. A posting naming one of these is out without needing its city in
// the table — otherwise "Dallas, TX" rides the unresolved fallback into a
// model call.
const FAR_STATES =
  /(?:^|[,\s])(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NC|ND|OH|OK|OR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:[,\s.]|$)/;

export interface RadiusResult {
  ok: boolean;
  reason: "remote" | "inside" | "outside" | "unresolved";
  place?: string;
  miles?: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest name first, so "north tonawanda" wins over "tonawanda" and
// "new york city" over "new york".
const ORDERED = Object.keys(PLACES).sort((a, b) => b.length - a.length)
  .map((name) => [name, new RegExp(`\\b${esc(name)}\\b`)] as const);

/**
 * Resolve a free-text ATS location string against the radius.
 *
 * An unresolved location returns ok:true on purpose — an unknown place is not a
 * reason to spend nothing, and the model gets to judge it with the posting in
 * front of it. That fallback is exactly why the far cities are enumerated
 * above: without them "Brooklyn, NY" would be unresolved, and pass.
 */
export function withinRadius(
  location: string | null | undefined,
  radiusMiles = DEFAULT_RADIUS_MILES,
): RadiusResult {
  if (!location) return { ok: true, reason: "unresolved" };
  const raw = location.toLowerCase();
  if (REMOTE.test(raw)) return { ok: true, reason: "remote" };

  for (const [name, re] of ORDERED) {
    if (!re.test(raw)) continue;
    const miles = distanceMiles(ORIGIN, PLACES[name]);
    return {
      ok: miles <= radiusMiles,
      reason: miles <= radiusMiles ? "inside" : "outside",
      place: name,
      miles: Math.round(miles),
    };
  }
  // No city matched. A named far state is still a definite answer.
  if (FAR_STATES.test(location.toUpperCase())) {
    return { ok: false, reason: "outside" };
  }
  return { ok: true, reason: "unresolved" };
}
