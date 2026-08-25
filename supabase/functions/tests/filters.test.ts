import { assertEquals } from "./assert.ts";
import { locationOk, titleOk } from "../_shared/filters.ts";

const KEEP = [
  "Director of Operations", "Plant Manager", "VP, Supply Chain",
  "Distribution Center Supervisor", "Operations Manager",
  "Warehouse Operations Manager", "Terminal Manager",
  "Continuous Improvement Manager", "Fleet Maintenance Supervisor",
  "Operational Excellence Lead",
];

const DROP = [
  "Warehouse Associate", "CDL Driver", "Software Engineer", "Seasonal Picker",
  "Associate Director of Logistics", "Manufacturing Engineer I",
  "Manufacturing Engineer II", "Registered Nurse", "Part-Time Dispatcher",
  "Accounts Payable Clerk", "Marketing Manager",
];

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

Deno.test("locationOk — WNY and remote pass, elsewhere does not", () => {
  for (const l of ["Buffalo, NY", "Remote", "Amherst", "Western New York"]) {
    assertEquals(locationOk(l), true, l);
  }
  for (const l of ["Dallas, TX", "Chicago, IL"]) {
    assertEquals(locationOk(l), false, l);
  }
});

Deno.test("locationOk — unknown location is not a reason to spend nothing", () => {
  assertEquals(locationOk(null), true);
  assertEquals(locationOk(""), true);
  assertEquals(locationOk(undefined), true);
});
