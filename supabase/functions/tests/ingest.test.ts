// The ingest core's failure paths. These are the tests worth having: the
// close-stale step is the one that can destroy data if it fires on bad input.

import { assertEquals, assertStringIncludes } from "./assert.ts";
import { runIngest, type Db, type JobRow } from "../_shared/ingest.ts";
import type { Company, FetchJson } from "../_shared/adapters.ts";

const ACME: Company = {
  id: 7, name: "Acme", ats: "greenhouse", board_token: "acme", active: true,
} as Company;

const BOARD = {
  jobs: [{
    id: 1, title: "Operations Manager",
    location: { name: "Buffalo, NY" },
    absolute_url: "https://x", content: "<p>d</p>",
    updated_at: "2026-01-01T00:00:00Z",
  }],
};

class FakeDb implements Db {
  upserted: JobRow[][] = [];
  closedFor: { id: number; before: string }[] = [];
  crawled: number[] = [];
  constructor(
    private companies: Company[] = [ACME],
    private opts: { upsertThrows?: boolean; closeThrows?: boolean; staleCount?: number } = {},
  ) {}
  dueCompanies(): Promise<Company[]> {
    return Promise.resolve(this.companies);
  }
  upsertJobs(rows: JobRow[]): Promise<void> {
    if (this.opts.upsertThrows) return Promise.reject(new Error("write failed"));
    this.upserted.push(rows);
    return Promise.resolve();
  }
  closeStale(companyId: number, before: string): Promise<number> {
    if (this.opts.closeThrows) return Promise.reject(new Error("close failed"));
    this.closedFor.push({ id: companyId, before });
    return Promise.resolve(this.opts.staleCount ?? 1);
  }
  markCrawled(companyId: number): Promise<void> {
    this.crawled.push(companyId);
    return Promise.resolve();
  }
}

const okHttp: FetchJson = () => Promise.resolve(BOARD);
const deadHttp: FetchJson = () => Promise.reject(new Error("board timed out"));

Deno.test("closes postings that vanished from the board, scoped to that company", async () => {
  const db = new FakeDb();
  const r = await runIngest({ db, http: okHttp });
  assertEquals(r.postings_seen, 1);
  assertEquals(r.postings_closed, 1);
  assertEquals(db.closedFor.length, 1);
  assertEquals(db.closedFor[0].id, 7);
  assertEquals(db.crawled, [7]);
});

Deno.test("the close cutoff is stamped BEFORE the fetch, so this run's rows survive", async () => {
  const db = new FakeDb();
  const stamps = ["2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"];
  let i = 0;
  await runIngest({ db, http: okHttp, clock: () => stamps[Math.min(i++, 1)] });
  // Rows were written with the LATER stamp; the cutoff is the EARLIER one.
  assertEquals(db.closedFor[0].before, stamps[0]);
  assertEquals(db.upserted[0][0].last_seen, stamps[1]);
});

Deno.test("a failed fetch closes nothing and leaves last_crawled_at alone", async () => {
  const db = new FakeDb();
  const r = await runIngest({ db, http: deadHttp });
  assertEquals(db.closedFor, []);
  assertEquals(db.upserted, []);
  assertEquals(db.crawled, []);          // so the next run retries this company first
  assertEquals(r.errors, 1);
  assertStringIncludes(r.detail[0].error!, "board timed out");
});

Deno.test("a failed upsert closes nothing — a transient error must not empty a board", async () => {
  const db = new FakeDb([ACME], { upsertThrows: true });
  const r = await runIngest({ db, http: okHttp });
  assertEquals(db.closedFor, []);
  assertEquals(db.crawled, []);
  assertEquals(r.errors, 1);
  assertStringIncludes(r.detail[0].error!, "upsert");
});

Deno.test("a failed close is reported, not silently counted as success", async () => {
  const db = new FakeDb([ACME], { closeThrows: true });
  const r = await runIngest({ db, http: okHttp });
  assertEquals(r.postings_closed, 0);
  assertEquals(r.errors, 1);
  assertStringIncludes(r.detail[0].error!, "close");
});

Deno.test("an empty board closes everything — that is a real result, not an error", async () => {
  const db = new FakeDb([ACME], { staleCount: 12 });
  const empty: FetchJson = () => Promise.resolve({ jobs: [] });
  const r = await runIngest({ db, http: empty });
  assertEquals(r.postings_seen, 0);
  assertEquals(r.postings_closed, 12);
  assertEquals(r.errors, 0);
});

Deno.test("the wall-clock budget defers the rest instead of being killed mid-write", async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...ACME, id: i + 1, name: `Co${i}` }));
  const db = new FakeDb(many);
  let t = 0;
  const r = await runIngest({
    db, http: okHttp, budgetMs: 100,
    now: () => (t += 60),   // each check advances 60ms: 1st company runs, then over budget
  });
  assertEquals(r.companies_deferred_to_next_run, 5 - r.companies_crawled);
  assertEquals(r.companies_crawled < 5, true);
});

Deno.test("one company failing does not stop the others", async () => {
  const db = new FakeDb([
    { ...ACME, id: 1, name: "Dead", board_token: "dead" },
    { ...ACME, id: 2, name: "Live", board_token: "live" },
  ]);
  const http: FetchJson = (url) =>
    url.includes("dead") ? Promise.reject(new Error("503")) : Promise.resolve(BOARD);
  const r = await runIngest({ db, http });
  assertEquals(r.companies_crawled, 2);
  assertEquals(r.errors, 1);
  assertEquals(r.postings_seen, 1);
  assertEquals(db.crawled, [2]);
});

Deno.test("a crawl writes only postings at the right level, and says how many it dropped", () => {
  // Nothing filtered an ATS crawl before this. Survivable while the only
  // crawlable boards were three Workday tenants; not survivable with ADP —
  // Sonwil's board is mostly warehouse shifts at $19.56/hour, and the scorer
  // pays for every open posting it has not already judged.
  return (async () => {
    const written: JobRow[] = [];
    const report = await runIngest({
      db: {
        dueCompanies: () =>
          Promise.resolve([{ id: 1, name: "Sonwil", ats: "adp", board_token: "x" }]),
        upsertJobs: (rows) => {
          written.push(...rows);
          return Promise.resolve();
        },
        closeStale: () => Promise.resolve(0),
        markCrawled: () => Promise.resolve(),
      },
      http: () =>
        Promise.resolve({
          jobRequisitions: [
            { itemID: "1", requisitionTitle: "Warehouse Specialist - 1st Shift" },
            { itemID: "2", requisitionTitle: "Operations Manager" },
            { itemID: "3", requisitionTitle: "Forklift Operator" },
            { itemID: "4", requisitionTitle: "Director of Distribution" },
          ],
        }),
    });

    assertEquals(written.length, 2);
    assertEquals(written.map((r) => r.title).sort(),
      ["Director of Distribution", "Operations Manager"]);
    // Never a silent cap — a filter bug must not read as "nothing open".
    assertEquals(report.postings_below_level, 2);
    assertEquals(report.detail[0].below_level, 2);
    assertEquals(report.postings_seen, 2);
  })();
});
