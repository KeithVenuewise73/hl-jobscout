# JobScout

Searches employer career sites directly. No LinkedIn, no Indeed — each adapter
talks to the applicant-tracking system the employer already runs.

Everything runs on Supabase, on a schedule. **Nothing runs on Keith's machine.**
There is no terminal step in normal operation; the only thing he opens is
`dashboard.html`.

---

## How it runs

```
06:10 / 18:10 ET   jobscout-ingest    crawls employer boards -> jobscout.jobs
06:30 / 18:30 ET   jobscout-score     scores new postings    -> jobscout.scores
08:00 ET           jobscout-discover  resolves any unresolved company's ATS
```

Each is a Supabase Edge Function, fired by `pg_cron` via `jobscout.kick()`
(see `supabase/migrations/0002_jobscout_schedule.sql`). Every run writes what it
actually did to `jobscout.runs`, and the dashboard reads that back — so the
status strip says "never run" when nothing has run, rather than showing an
empty manifest that looks like "no matches today".

## Layout

| | |
|---|---|
| `supabase/migrations/0001_jobscout_schema.sql` | Tables, the `v_shortlist` view the dashboard reads, and the `runs` log |
| `supabase/migrations/0002_jobscout_schedule.sql` | `pg_cron` + `pg_net` wiring. Separate migration because applying it is what turns the machine on |
| `supabase/functions/_shared/` | Every decision lives here, with dependencies injected — this is what the tests exercise |
| `supabase/functions/jobscout-*/` | Wiring only. Supabase in, shared core out; nothing here decides anything |
| `dashboard.html` | The shortlist. Runs locally, reads with the anon key |
| `seed_companies.csv` | 59 WNY employers weighted toward the target profile |

The split is deliberate: the sandbox that builds this cannot reach jsr.io, npm,
or any employer site, so anything that matters has to be provable without them.
Cores are pure and injected; the edge functions are thin enough to read.

## Tests

```
deno test supabase/functions/tests/
```

43 tests, no network, about a second. They cover the adapter field mapping
against recorded ATS payloads, the stage-1 filters, the SSRF guard, and — the
ones worth having — the ingest failure paths, because the close-stale step is
the one that can destroy data if it fires on bad input.

**What the tests do not cover:** whether the live boards still return the JSON
these adapters expect. That needs a real crawl. A board that changes its shape
breaks ingest and every test still passes.

## What's real vs. what's stubbed

| Piece | State |
|---|---|
| Greenhouse / Lever / Ashby / SmartRecruiters | JSON feeds, no scraping — parsing unit-tested, not yet run against a live board |
| Workday | Its own internal endpoint; slower, may need per-tenant tuning — parsing unit-tested, not yet run live |
| iCIMS, Paylocity, ADP, Paycom, UKG, Taleo | **Detected but not ingested** — each needs an adapter |
| Custom careers pages with no ATS | Not attempted |

The unsupported tier is where most of the actual targets live. Two ways forward
once the core is running:

1. **Adapters.** Paylocity and JazzHR both have parseable JSON behind their job
   list pages — each is maybe an hour. iCIMS and ADP are HTML scrapes.
2. **Change-detection fallback.** For any careers page with no ATS at all, hash
   the page text daily and alert on change. Crude, but it catches a new posting
   at a 40-person family distributor the same day it goes up — which is exactly
   the posting nobody else is seeing.

Option 2 is the one worth building next. It is simpler than the adapters and it
covers the companies that matter most.

## Cost

Scoring runs on `claude-opus-5`. The system prompt and the resume go as a
cached prefix that is byte-identical for every posting in a run, so a
250-posting run pays for the resume once and reads it from cache 249 times.
`JOBSCOUT_SCORE_EFFORT` (default `medium`) is the other knob. Every run records
its own token counts in `jobscout.runs` — if `cached` is 0, something is
varying inside the prefix and the run is costing roughly ten times what it
should.

## Turning it off

```sql
select cron.unschedule('jobscout-ingest-am');   -- and the other four
```
