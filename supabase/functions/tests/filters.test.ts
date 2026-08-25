import { assertEquals, assertTrue } from "./assert.ts";
import { eligible, locationOk, placeOk, titleOk } from "../_shared/filters.ts";

const KEEP = [
  "Director of Operations", "Plant Manager", "VP, Supply Chain",
  "Distribution Center Supervisor", "Operations Manager",
  "Warehouse Operations Manager", "Terminal Manager",
  "Continuous Improvement Manager", "Fleet Maintenance Supervisor",
  "Operational Excellence Lead",
];

const DROP = [
  "Warehouse Associate", "CDL Driver", "Software Engineer", "Seasonal Picker",
  "Manufacturing Engineer I", "Manufacturing Engineer II", "Registered Nurse",
  "Accounts Payable Clerk", "Marketing Manager", "Order Picker", "Custodian",
];
// "Associate Director of Logistics" used to live in DROP. It is now rescued on
// purpose: the "associate" rule was aimed at "Warehouse Associate", and it was
// taking a senior title with it.

Deno.test("titleOk — keeps the roles worth paying to read", () => {
  for (const t of KEEP) assertEquals(titleOk(t), true, t);
});

Deno.test("titleOk — drops the rest for free", () => {
  for (const t of DROP) assertEquals(titleOk(t), false, t);
});

Deno.test("titleOk — whole word, not substring", () => {
  // The bug this replaced: "associate " never matched a title ENDING in
  // "Associate", so every warehouse-associate posting reached the model.
  assertEquals(titleOk("Warehouse Associate"), false);
  // ...and the inverse: a substring must not kill a real title.
  assertEquals(titleOk("Associated Grocers Operations Manager"), true);
  // "vp " never matched a title that is just "VP".
  assertEquals(titleOk("VP Distribution"), true);
});

// Regression set drawn from the real resume, not from a guess at the profile.
Deno.test("titles Keith has actually held all survive stage 1", () => {
  for (const t of [
    "Operations Manager – Last Mile",     // RXO
    "Market Manager",                     // CRST — the starter's list dropped this
    "Distribution Manager",               // Arctic Glacier
    "Operations Manager II",              // XPO / Amazon
    "Distribution Warehouse Supervisor",  // Sorrento Lactalis
    "VP Operations", "President", "Logistics Manager",  // Herman Movers
  ]) assertEquals(titleOk(t), true, t);
});

Deno.test("the owner-scale roles he is actually aiming at survive", () => {
  for (const t of [
    "Chief Operating Officer", "COO", "General Manager",
    "Associate Director of Operations", "Route Manager", "Hub Manager",
    "Depot Manager", "DSD Manager", "Carrier Manager", "Final Mile Manager",
  ]) assertEquals(titleOk(t), true, t);
});

Deno.test("Driver Manager is a management job; Delivery Driver is not", () => {
  // The rescue list exists for exactly this pair — one rule was killing both.
  assertEquals(titleOk("Driver Manager"), true);
  assertEquals(titleOk("Driver Supervisor"), true);
  assertEquals(titleOk("Delivery Driver"), false);
  assertEquals(titleOk("CDL Driver Class A"), false);
});

Deno.test("short include terms are bounded on both sides", () => {
  assertEquals(titleOk("VP Supply Chain"), true);
  assertEquals(titleOk("Hub Manager"), true);
  // ...so they do not match inside longer words.
  assertEquals(titleOk("Hubbard Family Foods Recruiter"), false);
  assertEquals(titleOk("VPN Support Engineer"), false);
});

Deno.test("a title must name a LEVEL, not just a function", () => {
  // The include list carries broad function words that are right inside a
  // manager title and wrong alone. A real Indeed digest of eleven
  // "distribution jobs" was eleven floor roles at $17-25/hour; these three
  // reached the model on the function word alone before this rule existed.
  for (const t of ["WAREHOUSE OPERATIONS", "Shipping and Receiving",
                   "Logistics Customer Service Representative $45,000 year",
                   "Warehouse 1st shift", "Load Operator",
                   "Packaging Material Handler", "Stockroom Team Leader"]) {
    assertEquals(titleOk(t), false, t);
  }
  // ...and the same function words still pass WITH a level word attached.
  for (const t of ["Warehouse Manager", "Shipping Supervisor",
                   "Director of Logistics", "Plant Superintendent"]) {
    assertEquals(titleOk(t), true, t);
  }
});

Deno.test("target level: Sr Manager / Director and up survive", () => {
  for (const t of ["Senior Manager, Logistics", "Sr Manager Distribution",
                   "Director of Operations", "Head of Distribution - North America",
                   "VP Operations", "Senior Director, Supply Chain",
                   "Chief Operating Officer"]) {
    assertEquals(titleOk(t), true, t);
  }
});

Deno.test("unambiguously junior titles die free", () => {
  for (const t of ["Assistant Manager", "Shift Supervisor", "Shift Manager",
                   "Team Lead", "Crew Leader", "Management Trainee",
                   "Associate Manager", "Assistant Director of Operations"]) {
    assertEquals(titleOk(t), false, t);
  }
});

Deno.test("but arguable titles are left for the model to judge on scope", () => {
  // A keyword cannot tell an 80-person DC manager from a shift lead. These are
  // the titles Keith has actually held, and they stay in.
  for (const t of ["Operations Manager", "Distribution Manager", "Plant Manager",
                   "Market Manager", "Warehouse Manager", "General Manager"]) {
    assertEquals(titleOk(t), true, t);
  }
});

Deno.test("area/regional/district manager survive — real alert-email titles", () => {
  // "Area Manager at B&T Building Services, Buffalo" came through a LinkedIn
  // alert and was dropped: a legitimate multi-site ops title that was in
  // neither list.
  for (const t of ["Area Manager", "Regional Manager", "District Manager"]) {
    assertEquals(titleOk(t), true, t);
  }
});

Deno.test("locationOk — now a real 50-mile radius, not a substring list", () => {
  for (const l of ["Buffalo, NY", "Remote", "Amherst", "Western New York"]) {
    assertEquals(locationOk(l), true, l);
  }
  for (const l of ["Dallas, TX", "Chicago, IL"]) {
    assertEquals(locationOk(l), false, l);
  }
  // These used to pass. The old list contained "new york" and " ny", so the
  // gate admitted the entire state.
  for (const l of ["Brooklyn, NY", "Albany, NY", "Rochester, NY"]) {
    assertEquals(locationOk(l), false, l);
  }
});

Deno.test("locationOk — unknown location is not a reason to spend nothing", () => {
  assertEquals(locationOk(null), true);
  assertEquals(locationOk(""), true);
  assertEquals(locationOk(undefined), true);
});

Deno.test("the posting that got away: 'Remote' in the title, a city in the field", () => {
  // Real miss. LinkedIn filed "Director of Logistics - Remote Healthcare
  // Screening" under Winter Park, FL — the employer's address — and the radius
  // gate dropped it. The title said remote; nothing was reading the title.
  const j = {
    title: "Director of Logistics - Remote Healthcare Screening",
    location: "Winter Park, FL",
  };
  assertEquals(placeOk(j).ok, false);
  assertEquals(placeOk(j, { locationIndependent: true }).reason, "remote_title");
});

Deno.test("a territory title is location-independent, whatever address is on it", () => {
  // "Director, North America Logistics" is a territory, not a commute. The
  // address on the posting is where the company sits, not where the work is.
  for (const t of [
    "Director, North America Logistics",
    "National Director of Operations",
    "Global Head of Supply Chain",
    "Multi-Site Operations Director",
    "Divisional Operations Manager",
    "Director of Field Operations",
  ]) {
    const v = placeOk({ title: t, location: "Costa Mesa, CA" }, { locationIndependent: true });
    assertEquals(v.ok, true, t);
    assertEquals(v.reason, "travelling_scope", t);
  }
});

Deno.test("location independence is opt-in and does not weaken the radius", () => {
  // Someone who wants a commute only must still get a commute only.
  const j = { title: "National Director of Operations", location: "Dallas, TX" };
  assertEquals(placeOk(j).ok, false);
  assertEquals(placeOk(j).reason, "out_of_area");
  // And a genuinely local job is still reported as local, not as a territory.
  const local = { title: "National Director of Operations", location: "Amherst, NY" };
  assertEquals(placeOk(local, { locationIndependent: true }).reason, "in_radius");
});

Deno.test("an ordinary out-of-area job stays out, even with independence on", () => {
  // The expansion must admit territory and remote roles, NOT everything.
  // A plain plant manager in Dallas is still a relocation, not a commute.
  for (const t of ["Plant Manager", "Warehouse Operations Manager", "Distribution Manager"]) {
    const v = placeOk({ title: t, location: "Dallas, TX" }, { locationIndependent: true });
    assertEquals(v.ok, false, t);
  }
});

Deno.test("eligible() still accepts a bare radius number", () => {
  // Older callers pass a number. Breaking them silently would narrow the search
  // without anyone noticing.
  const jobs = [
    { title: "Operations Director", location: "Buffalo, NY" },
    { title: "Operations Director", location: "Dallas, TX" },
  ];
  assertEquals(eligible(jobs, 50).length, 1);
  assertEquals(eligible(jobs, { radiusMiles: 50 }).length, 1);
});

Deno.test("with independence on, the national digest stops being thrown away", () => {
  // The six postings from one real "director of distribution in North America"
  // digest. Every one was dropped before; the ones that are genuinely
  // location-independent now reach the model.
  const digest = [
    { title: "Director of Operations", location: "Virginia, United States" },
    { title: "Director of Logistics - Remote Healthcare Screening", location: "Winter Park, FL" },
    { title: "Director Global Logistics", location: "Costa Mesa, CA" },
    { title: "Head Of Supply Chain", location: "Alameda, CA" },
    { title: "Director of Wholesale Operations", location: "New York, NY" },
    { title: "Head of Operations", location: "Glendale, AZ" },
  ];
  assertEquals(eligible(digest, { radiusMiles: 50 }).length, 0);
  const opened = eligible(digest, { radiusMiles: 50, locationIndependent: true });
  // The two that say so in their titles; the rest are still relocations.
  assertEquals(opened.length, 2);
  assertTrue(opened.some((j) => j.title.includes("Remote Healthcare")));
  assertTrue(opened.some((j) => j.title.includes("Global Logistics")));
});
