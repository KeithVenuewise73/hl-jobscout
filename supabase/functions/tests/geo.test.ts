// The radius gate. This is the filter that decides what reaches the model, so
// its failure mode is either a wasted bill or a job Keith never sees.

import { assertEquals, assertTrue } from "./assert.ts";
import { distanceMiles, ORIGIN, PLACES, withinRadius } from "../_shared/geo.ts";

Deno.test("the substring list this replaced passed the whole state", () => {
  // "new york", " ny" and "ny," were in the allow-list, so every NY posting
  // matched — including the 290-mile-away ones the gate existed to stop.
  for (const l of ["New York, NY", "Brooklyn, NY", "Yonkers, NY",
                   "Long Island City, NY", "Albany, NY", "Syracuse, NY"]) {
    assertEquals(withinRadius(l).ok, false, l);
  }
});

Deno.test("WNY towns are inside 50 miles", () => {
  for (const l of ["Buffalo, NY", "Amherst, NY", "Orchard Park, NY",
                   "Lockport, NY", "Niagara Falls, NY", "Batavia, NY",
                   "Dunkirk, NY", "Springville, NY"]) {
    const r = withinRadius(l);
    assertEquals(r.ok, true, `${l} -> ${r.reason} ${r.miles}`);
  }
});

Deno.test("regional phrasings resolve to Buffalo, not to New York City", () => {
  // "Western New York" contains "new york". Without an explicit longer entry
  // the longest-name-first scan resolves it to NYC and drops a local posting
  // as 292 miles away — which is exactly what the first run of this test found.
  for (const l of ["Western New York", "WNY", "Buffalo Niagara region",
                   "Erie County, NY"]) {
    const r = withinRadius(l);
    assertEquals(r.ok, true, `${l} -> ${r.reason} ${r.miles}`);
  }
});

Deno.test("Jamestown is a near miss, and the gate says so rather than guessing", () => {
  const r = withinRadius("Jamestown, NY");
  assertEquals(r.ok, false);
  assertEquals(r.miles, 57);   // 7 miles past the line — widen the radius, not the code
});

Deno.test("the Rochester corridor is outside 50 miles — and says how far", () => {
  const r = withinRadius("Rochester, NY");
  assertEquals(r.ok, false);
  assertEquals(r.reason, "outside");
  assertTrue((r.miles ?? 0) > 60, "Rochester is ~67 miles out");
});

Deno.test("radius is a parameter, not a hardcoded assumption", () => {
  // Same posting, two policies. Widening the radius is one number.
  assertEquals(withinRadius("Rochester, NY", 50).ok, false);
  assertEquals(withinRadius("Rochester, NY", 80).ok, true);
});

Deno.test("longest place name wins", () => {
  // "north tonawanda" must not resolve as "tonawanda", and "new york city"
  // must not resolve as some other "new york" entry.
  assertEquals(withinRadius("North Tonawanda, NY").place, "north tonawanda");
  assertEquals(withinRadius("New York City").place, "new york city");
});

Deno.test("remote passes regardless of the city named", () => {
  for (const l of ["Remote", "Remote - US", "Remote (Dallas, TX)", "Work from home"]) {
    assertEquals(withinRadius(l).reason, "remote", l);
  }
});

Deno.test("a far state is a definite answer, not a fallback pass", () => {
  // Without this, "Dallas, TX" would be unresolved and buy a model call.
  for (const l of ["Dallas, TX", "Columbus, OH", "Charlotte, NC", "Newark, NJ"]) {
    assertEquals(withinRadius(l).ok, false, l);
  }
});

Deno.test("an unknown place still reaches the model", () => {
  // An unrecognized town is not a reason to spend nothing — the model judges it
  // with the posting in front of it. This is the deliberate safe direction.
  for (const l of ["Warsaw, NY", "Multiple Locations", "", null, undefined]) {
    assertEquals(withinRadius(l as string).ok, true, String(l));
  }
});

Deno.test("distance is real, not a lookup table of guesses", () => {
  assertEquals(Math.round(distanceMiles(ORIGIN, PLACES["buffalo"])), 0);
  // Sanity-check a couple of known separations.
  assertTrue(Math.abs(distanceMiles(ORIGIN, PLACES["rochester"]) - 67) < 6);
  assertTrue(Math.abs(distanceMiles(ORIGIN, PLACES["niagara falls"]) - 16) < 5);
});
