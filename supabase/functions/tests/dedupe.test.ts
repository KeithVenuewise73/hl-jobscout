// Near-duplicate detection, tested against the real postings that motivated it.
//
// A wrong MERGE hides a job Keith never learns exists. A wrong SPLIT costs a
// model call. The tests below pin both directions.

import { assertEquals, assertTrue } from "./assert.ts";
import {
  groupDuplicates, mergedLocation, normTitle, representative, sameJob,
  similarity, SIMILAR_ENOUGH,
} from "../_shared/dedupe.ts";

// Verbatim openings from two of The Tile Shop's five store postings. The
// second is the first with an extra paragraph on the front — the hardest real
// case, because neither is a copy of the other.
const TILE_LITTLETON = `The In-Store Warehouse Manager is responsible for:
Helping oversee the warehouse at the store itself.
Preparing packing and shipping documents.
Picking and staging outbound shipments.
Ensuring inbound & outbound shipments are accurate & damage-free.
Maintaining a clean, neat, and orderly work area.
They must also have the ability to manually move and lift 50 to 100 lb. boxes of
tile on a regular basis and have the flexibility to work nights and weekends
within a team rotation.
Read customer orders, work orders, shipping order, or requisition to assemble
customer orders from stock and place order on pallet or shelves.`;

const TILE_DENVER = `The Tile Shop is NOW HIRING a FULL TIME and IN-STORE
Warehouse Manager. The Manager title is not management of personnel at this
time. It is management of the warehouse space/shipping and receiving as well as
working cohesively with the Showroom staff to ensure correct, timely, above and
beyond customer service is the standard at the location.
The In-Store Warehouse Manager is responsible for:
Helping oversee the warehouse at the store itself.
Preparing packing and shipping documents.
Picking and staging outbound shipments.
Ensuring inbound & outbound shipments are accurate & damage-free.
Maintaining a clean, neat, and orderly work area.
They must also have the ability to manually move and lift 50 to 100 lb. boxes of
tile on a regular basis and have the flexibility to work nights and weekends
within a team rotation.
Read customer orders, work orders, shipping order, or requisition to assemble
customer orders from stock and place order on pallet or shelves.`;

Deno.test("the real store postings are recognized as one job", () => {
  // Six rows, FIVE distinct descriptions — exact hashing collapses none of
  // them, which is the whole reason this file exists.
  const sim = similarity(TILE_LITTLETON, TILE_DENVER);
  assertTrue(sim >= SIMILAR_ENOUGH, `similarity was ${sim.toFixed(2)}`);
  assertTrue(
    sameJob(
      { id: 53, company_id: 9, title: "Warehouse Manager", description: TILE_LITTLETON },
      { id: 54, company_id: 9, title: "Warehouse Manager", description: TILE_DENVER },
    ),
  );
});

Deno.test("two genuinely different jobs sharing a title stay apart", () => {
  // Boilerplate — benefits, EEO, company blurb — can be half a posting. Three
  // word shingles are what stop that alone from merging different roles.
  const boiler = `We offer competitive pay, medical dental and vision coverage,
    a 401k with company match, paid time off and tuition assistance. The Tile
    Shop is an equal opportunity employer and does not discriminate on the basis
    of race, color, religion, sex, national origin, age, disability or veteran
    status. All qualified applicants are encouraged to apply.`;
  const warehouse = `Picking and staging outbound shipments, preparing packing
    and shipping documents, lifting 50 to 100 lb boxes of tile. ${boiler}`;
  const finance = `Own the monthly close, prepare consolidated statements,
    manage a team of four analysts, and present variance analysis to the CFO.
    ${boiler}`;
  assertTrue(similarity(warehouse, finance) < SIMILAR_ENOUGH,
    `similarity was ${similarity(warehouse, finance).toFixed(2)}`);
  assertEquals(
    sameJob(
      { id: 1, company_id: 9, title: "Operations Manager", description: warehouse },
      { id: 2, company_id: 9, title: "Operations Manager", description: finance },
    ),
    false,
  );
});

Deno.test("a different employer is never the same job", () => {
  assertEquals(
    sameJob(
      { id: 1, company_id: 1, title: "Warehouse Manager", description: TILE_DENVER },
      { id: 2, company_id: 2, title: "Warehouse Manager", description: TILE_DENVER },
    ),
    false,
  );
});

Deno.test("the cross-source case: one copy has no description to disagree with", () => {
  // New Era Cap's "Manager, Logistics (North America)" arrived from a LinkedIn
  // alert with nothing but a title, and from ADP with a description and a
  // salary. Two rows, two scores — 54 and 56 — for one job.
  const li = { id: 2, company_id: 12, title: "Manager, Logistics (North America)" };
  const adp = {
    id: 40, company_id: 12, title: "Manager, Logistics (North America)",
    description: "Own the North America carrier network...".repeat(20),
    comp_text: "$75,000 - $95,000 per year",
  };
  assertTrue(sameJob(li, adp));
  // The described copy is the one worth scoring — its verdict is inherited.
  assertEquals(representative([li, adp]).id, 40);
});

Deno.test("titles differing only in case or punctuation are the same title", () => {
  assertEquals(normTitle("Sr. Manager, Logistics"), normTitle("SR MANAGER LOGISTICS"));
  assertTrue(
    sameJob(
      { id: 1, company_id: 3, title: "Director, Operations" },
      { id: 2, company_id: 3, title: "Director Operations" },
    ),
  );
  // But a real difference in title is a real difference in job.
  assertEquals(
    sameJob(
      { id: 1, company_id: 3, title: "Director, Operations" },
      { id: 2, company_id: 3, title: "Senior Director, Operations" },
    ),
    false,
  );
});

Deno.test("every location survives the merge — the group is judged on all of them", () => {
  // The five Tile Shop stores are Littleton CO, Denver CO, Colonie NY,
  // Cheektowaga NY and Avon MA. Scoring one copy and copying its verdict would
  // judge the job on ONE of those: pick a Colorado row and a Buffalo-commutable
  // job reads as a relocation.
  const g = [
    { id: 53, company_id: 9, title: "Warehouse Manager", location: "Littleton, CO" },
    { id: 56, company_id: 9, title: "Warehouse Manager", location: "Cheektowaga, NY" },
    { id: 57, company_id: 9, title: "Warehouse Manager", location: "Avon, MA" },
  ];
  const m = mergedLocation(g) ?? "";
  assertTrue(m.includes("Cheektowaga, NY"), m);
  assertTrue(m.includes("Littleton, CO"), m);
  assertTrue(m.includes("(3 locations)"), m);
  // A single location is reported plainly, not dressed up as a list of one.
  assertEquals(mergedLocation([g[1]]), "Cheektowaga, NY");
  assertEquals(mergedLocation([{ id: 1, company_id: 1, title: "x" }]), null);
});

Deno.test("grouping collapses the real duplicate set to one entry per job", () => {
  const jobs = [
    { id: 53, company_id: 9, title: "Warehouse Manager", location: "Littleton, CO", description: TILE_LITTLETON },
    { id: 54, company_id: 9, title: "Warehouse Manager", location: "Denver, CO", description: TILE_DENVER },
    { id: 56, company_id: 9, title: "Warehouse Manager", location: "Cheektowaga, NY", description: TILE_LITTLETON },
    { id: 99, company_id: 9, title: "Warehouse Manager", location: "Cheektowaga, NY" }, // from the alert
    { id: 7, company_id: 12, title: "Manager, Logistics (North America)", location: "Buffalo, NY" },
  ];
  const groups = groupDuplicates(jobs);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].length, 4);
  assertEquals(groups[1].length, 1);
});

Deno.test("a lone job is a group of one, and order is stable", () => {
  const jobs = [
    { id: 1, company_id: 1, title: "Operations Director" },
    { id: 2, company_id: 2, title: "Plant Manager" },
  ];
  const groups = groupDuplicates(jobs);
  assertEquals(groups.length, 2);
  assertEquals(groups.map((g) => g[0].id), [1, 2]);
  assertEquals(groupDuplicates([]).length, 0);
});
