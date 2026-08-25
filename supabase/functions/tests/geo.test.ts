// The radius gate. This decides what reaches the model, so its failure modes
// are a wasted bill or a job Keith never sees.
//
// The cases below are mostly regressions: each one is a bug a previous version
// of this file actually shipped.

import { assertEquals, assertTrue } from "./assert.ts";
import { distanceMiles, ORIGIN, withinRadius } from "../_shared/geo.ts";
import { PLACE_COORDS, ZIP_COORDS } from "../_shared/gazetteer.ts";

Deno.test("a ZIP resolves exactly, with or without a city beside it", () => {
  // The reason to prefer a ZIP: no name collisions, no alternate spellings.
  for (const l of ["14221", "Amherst, NY 14221", "Buffalo NY 14202-1234"]) {
    const r = withinRadius(l);
    assertEquals(r.ok, true, l);
    assertEquals(r.reason, "zip", l);
  }
});

Deno.test("the substring list this replaced passed the whole state", () => {
  // v1's allow-list held "new york", " ny" and "ny,", so every NY posting
  // matched — including the ones 290 miles away it existed to stop.
  for (const l of ["New York, NY", "Brooklyn, NY", "Yonkers, NY", "Albany, NY",
                   "Syracuse, NY", "Rochester, NY"]) {
    assertEquals(withinRadius(l).ok, false, l);
  }
});

Deno.test("regions resolve to their region, not to a city inside their name", () => {
  // v2 matched "new york" inside "Western New York" and filed a Buffalo job as
  // 292 miles out. Regions are therefore tested before cities.
  for (const l of ["Western New York", "WNY", "W.N.Y.", "Buffalo-Niagara",
                   "Erie County, NY"]) {
    const r = withinRadius(l);
    assertEquals(r.ok, true, `${l} -> ${r.reason} ${r.miles}`);
  }
});

Deno.test("small WNY towns resolve — the hand-typed table did not have them", () => {
  // v2 knew ~50 towns. Everything else fell through to the unresolved pass and
  // bought a model call. These are real places inside the radius.
  for (const l of ["Warsaw, NY", "Silver Creek, NY", "Gowanda, NY", "Medina, NY",
                   "Arcade, NY", "Perry, NY", "Akron, NY", "Alden, NY"]) {
    const r = withinRadius(l);
    assertEquals(r.ok, true, `${l} -> ${r.reason} ${r.miles}`);
    assertEquals(r.reason, "city", l);
  }
});

Deno.test("near misses are reported with their distance, not guessed at", () => {
  const jamestown = withinRadius("Jamestown, NY");
  assertEquals(jamestown.ok, false);
  assertTrue((jamestown.miles ?? 0) > 50 && (jamestown.miles ?? 0) < 65);

  const olean = withinRadius("Olean, NY");
  assertEquals(olean.ok, false);
  assertTrue((olean.miles ?? 0) > 50 && (olean.miles ?? 0) < 70);
});

Deno.test("radius is a parameter, not an assumption baked into the data", () => {
  // Widening the search is one number, not a code change.
  assertEquals(withinRadius("Rochester, NY", 50).ok, false);
  assertEquals(withinRadius("Rochester, NY", 80).ok, true);
  assertEquals(withinRadius("Jamestown, NY", 60).ok, true);
});

Deno.test("remote passes whatever city sits next to it", () => {
  for (const l of ["Remote", "Remote - US", "Remote (Dallas, TX)", "Work from home",
                   "Telecommute"]) {
    assertEquals(withinRadius(l).reason, "remote", l);
  }
});

Deno.test("a far state settles it without needing the city", () => {
  // Otherwise "Dallas, TX" rides the unresolved fallback into a paid call.
  for (const l of ["Dallas, TX", "Columbus, OH", "Charlotte, NC", "Newark, NJ",
                   "Somewhere, AZ"]) {
    assertEquals(withinRadius(l).ok, false, l);
  }
});

Deno.test("the far-state shortcut stands down when the radius outgrows it", () => {
  // Ohio's nearest point is ~140 miles out, so the blanket rule is true at 50
  // and false at 200. Rather than encode that per state, it stops applying and
  // the model judges — a wrong exclusion is worse than a wasted call.
  assertEquals(withinRadius("Columbus, OH", 50).ok, false);
  assertEquals(withinRadius("Columbus, OH", 250).ok, true);
});

Deno.test("an unknown place still reaches the model", () => {
  // Deliberate: an unrecognized location is not a reason to spend nothing. It
  // is also why far places must be IN the gazetteer rather than merely absent.
  for (const l of ["Multiple Locations", "Various", "", "   ", null, undefined]) {
    assertEquals(withinRadius(l as string).ok, true, String(l));
  }
});

Deno.test("USPS alternate names resolve to the same place", () => {
  // "Williamsville" is an acceptable_city on a Buffalo ZIP. An ATS may print
  // either, and both must land in the radius.
  for (const l of ["Williamsville, NY", "Depew, NY", "Kenmore, NY",
                   "East Amherst, NY"]) {
    assertEquals(withinRadius(l).ok, true, l);
  }
});

Deno.test("the generated gazetteer is present and plausible", () => {
  assertTrue(Object.keys(PLACE_COORDS).length > 2000, "places");
  assertTrue(Object.keys(ZIP_COORDS).length > 2000, "zips");
  // Origin sanity: Buffalo's own ZIP should be ~0 miles out.
  const buf = ZIP_COORDS["14202"];
  assertTrue(buf !== undefined, "14202 present");
  assertTrue(distanceMiles(ORIGIN, { lat: buf[0], lon: buf[1] }) < 5);
});
