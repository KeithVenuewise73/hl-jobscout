# JobScout

Searches employer career sites directly. No LinkedIn, no Indeed — each adapter
talks to the applicant-tracking system the employer already runs.

Everything runs on Supabase, on a schedule. **Nothing runs on Keith's machine.**
There is no terminal step in normal operation; the only thing he opens is a
bookmark.

**The page does not render yet, and the reason is not in this code.** Anything
served from `*.supabase.co` comes back rewritten to `text/plain` with `nosniff`
and `content-security-policy: default-src 'none'; sandbox`, so a browser shows
the markup as source. Measured on this project against the identical file:

| Path | Response |
|---|---|
| `/functions/v1/jobscout-dashboard` | `text/plain`, nosniff, sandbox |
| `/storage/v1/object/public/dash/...` | `text/plain`, nosniff, sandbox |
| `/storage/v1/object/sign/dash/...?token=` | `text/plain`, nosniff, sandbox |

That is the platform declining to host HTML on a domain shared by every
project, not a bug to work around. The page needs a host that renders HTML — a
custom domain on this project, or somewhere else. Only `pageUrl()` in
`_shared/page.ts` changes when that is decided; the bookmark points at the
function, which redirects, so it survives the move.

---

## How it runs

```
06:10 / 18:10 ET   jobscout-ingest    crawls employer boards -> jobscout.jobs
06:30 / 18:30 ET   jobscout-score     scores new postings    -> jobscout.scores
08:00 ET           jobscout-discover  resolves any unresolved company's ATS
```

Each is a Supabase Edge Function, fired by `pg_cron` via `jobscout.kick()`
(see `supabase/migrations/0006_jobscout_schedule.sql`). Every run writes what it
actually did to `jobscout.runs`, and the dashboard reads that back — so the
status strip says "never run" when nothing has run, rather than showing an
empty manifest that looks like "no matches today".

## Layout

| | |
|---|---|
| `supabase/migrations/0001_jobscout_schema.sql` | Tables, the `v_shortlist` view the dashboard reads, and the `runs` log |
| `supabase/migrations/0006_jobscout_schedule.sql` | `pg_cron` + `pg_net` wiring. Separate migration because applying it is what turns the machine on |
| `supabase/migrations/0007_jobscout_view_token.sql` | The read token the dashboard link carries. Separate from the run token on purpose — reading the shortlist must not be able to start a run |
| `supabase/migrations/0008_jobscout_dash_bucket.sql` | The bucket the page is written to. No RLS policy on purpose: the path contains the token, so listing must stay impossible |
| `supabase/functions/_shared/` | Every decision lives here, with dependencies injected — this is what the tests exercise |
| `tools/build_gazetteer.py` | Regenerates `_shared/gazetteer.ts` from USPS ZIP data. Run it to move the origin or widen the kept footprint |
| `supabase/functions/jobscout-*/` | Wiring only. Supabase in, shared core out; nothing here decides anything |
| `supabase/functions/jobscout-dashboard/` | Writes the page to Storage on cron, redirects a bookmark to it, and records Applied / Not interested. The URL carries a read-only token; the browser never receives a credential |
| `dashboard.html` | Dead. A pointer left where an old bookmark lands |
| `seed_companies.csv` | 59 WNY employers weighted toward the target profile |

The split is deliberate: the sandbox that builds this cannot reach jsr.io, npm,
or any employer site, so anything that matters has to be provable without them.
Cores are pure and injected; the edge functions are thin enough to read.

## Tests

```
deno test supabase/functions/tests/
```

157 tests, no network, about a second. They cover the adapter field mapping
against recorded ATS payloads, the stage-1 filters, the SSRF guard, and — the
ones worth having — the ingest failure paths, because the close-stale step is
the one that can destroy data if it fires on bad input.

`no-import-prefix` is excluded in `deno.json`. Supabase Edge Functions are
required to import via inline `jsr:` / `npm:` specifiers — that is the
deployment contract, not a shortcut — so leaving the rule on meant every lint
run reported four errors that must not be fixed, which is how a lint stops
being read.

**What the tests do not cover:** whether the live boards still return the JSON
these adapters expect. That needs a real crawl. A board that changes its shape
breaks ingest and every test still passes.

## What's real vs. what's stubbed

| Piece | State |
|---|---|
| Greenhouse / Lever / Ashby / SmartRecruiters | JSON feeds, no scraping — parsing unit-tested, not yet run against a live board |
| Workday | Its own internal endpoint; slower, may need per-tenant tuning — parsing unit-tested, not yet run live |
| ADP | Live — field names read off a real employer response, not documentation |
| iCIMS, Paylocity, Paycom, UKG, Taleo, SuccessFactors | **Detected but not ingested** — each needs an adapter |
| Custom careers pages with no ATS | Not attempted |

The unsupported tier is where most of the actual targets live. Two ways forward
once the core is running:

1. **Adapters.** Paylocity and JazzHR both have parseable JSON behind their job
   list pages — each is maybe an hour. iCIMS is an HTML scrape; ADP is done.
2. **Change-detection fallback.** For any careers page with no ATS at all, hash
   the page text daily and alert on change. Crude, but it catches a new posting
   at a 40-person family distributor the same day it goes up — which is exactly
   the posting nobody else is seeing.

Option 2 is the one worth building next. It is simpler than the adapters and it
covers the companies that matter most.

## The radius

`JOBSCOUT_SCORE_*` aside, the one number that decides what gets looked at is
`DEFAULT_RADIUS_MILES` in `_shared/geo.ts` — 50, measured from Buffalo.

A posting's location resolves in this order: remote, then ZIP code (exact),
then a region phrase, then city + state. The gazetteer behind it is generated
from USPS ZIP data by `tools/build_gazetteer.py` — 4,726 place names including
USPS alternates, and 4,470 ZIP centroids. Regenerate it with:

```
pip install zipcodes && python tools/build_gazetteer.py
```

Two behaviours worth knowing before tuning it:

- **An unrecognized location passes.** An unknown place is not a reason to
  spend nothing; the model judges it with the posting in hand. That is also why
  far-away places have to be IN the gazetteer — they must be present to be
  excluded, not merely absent.
- **Widening the radius is one number.** The data is not built around 50 miles;
  it keeps everything within 150, so raising the radius needs no regeneration.

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
