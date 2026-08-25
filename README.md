# JobScout — 24-hour runbook

Searches employer career sites directly. No LinkedIn, no Indeed.

**Total hands-on time: about 4 hours.** The rest is the machine running.

---

## Hour 0 — schema (10 min)

1. Supabase → SQL Editor → paste `01_schema.sql` → Run.
2. Settings → API → **Exposed schemas**: add `jobscout`. (The dashboard can't read it otherwise.)
3. Grab your **Project URL**, **anon key**, and **service_role key**.

```bash
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_KEY="eyJ...service_role..."
export ANTHROPIC_API_KEY="sk-ant-..."
pip install -r requirements.txt
```

## Hour 1 — resolve the employer list (45 min, mostly unattended)

`seed_companies.csv` has 59 WNY employers weighted toward your target profile.
`discover.py` visits each careers page and figures out which ATS they run.

```bash
python discover.py --csv seed_companies.csv --out companies_resolved.csv
```

Expect roughly 15–25 of the 59 to land on an ATS with a JSON feed. That's the
honest hit rate for this segment — small private employers largely don't use
Greenhouse or Lever. The output CSV flags `supported=True/False` per company.

Then load it into Supabase: Table Editor → `jobscout.companies` → Import CSV.
Import all of them, supported or not — the unsupported ones are still your
target list, they just need a bookmark instead of a crawler for now.

## Hour 2 — first crawl (20 min)

```bash
python -m unittest         # 16 tests, no network, ~1s — run after any edit
python ingest.py --dry-run    # sanity check
python ingest.py              # write
```

If a company errors, the token is wrong. Fix it in the `companies` table and
re-run — the upsert is idempotent, so re-running is always safe.

Each run also closes postings that have disappeared from a board (`is_open` goes
false), so the shortlist stops showing jobs that are already filled. That only
happens for companies that fetched *and* wrote successfully — a timeout or a bad
token leaves the existing postings alone rather than wiping the board.

## Hour 3 — load your resume, then score (60 min)

Insert your resume as plain text. SQL Editor:

```sql
insert into jobscout.resumes (label, content, comp_floor, dealbreakers)
values (
  'keith-ops-2026',
  $$PASTE FULL RESUME TEXT HERE$$,
  80000,
  array['relocation required','75% travel','commission-only']
);
```

Then:

```bash
python score.py --resume keith-ops-2026
```

Read the first 20 lines of output. If everything is scoring 70+, the model is
being generous — tighten the `SYSTEM` prompt in `score.py`. If nothing clears
55, loosen `TITLE_INCLUDE`. Getting this calibration right is the difference
between a tool you use and a tool you stop opening.

Scoring runs on `claude-opus-5`. Two knobs matter for cost:

- `--effort low|medium|high|xhigh|max` (default `medium`) — how hard the model
  thinks per posting.
- The resume and the scoring instructions are sent as a cached prefix, identical
  for every posting in a run, so you pay full price for them once and ~10% after
  that. The run prints its own token accounting at the end; if the `cached`
  number is 0, something is varying inside the prefix.

`--limit` (default 250) caps how many postings reach the model in one run. When
it bites, the run says so and how many it held back.

## Hour 4 — dashboard

Open `dashboard.html` in a browser, paste your project URL and **anon key**,
click Load manifest. Click any row to see the fit reasoning and the cover-letter
angle for that specific job. The status dropdown writes back to
`jobscout.applications`.

**Run it locally.** If you ever host it, put RLS policies on the `jobscout`
tables first — the anon key is public by design.

## Then: cron it

```
0 6,18 * * *  cd /path/to/jobscout && python ingest.py && python score.py --resume keith-ops-2026
```

Twice a day. Postings from small employers get filled fast; being in the first
ten applicants matters more than the cover letter.

---

## What's real vs. what's stubbed

| Piece | State |
|---|---|
| Greenhouse / Lever / Ashby / SmartRecruiters | JSON feeds, no scraping — parsing unit-tested, not yet run against a live board |
| Workday | Its own internal endpoint; slower, may need per-tenant tuning — parsing unit-tested, not yet run live |
| iCIMS, Paylocity, ADP, Paycom, UKG, Taleo | **Detected but not ingested** — each needs an adapter |
| Custom WordPress careers pages | Not attempted |

**What has actually been run:** the adapter field-mapping, the stage-1 filters and
the stale-close path are covered by `python -m unittest` (16 tests, no network).
The ATS detection in `discover.py` and the adapters' behaviour against live
boards have *not* been verified — that needs a machine with outbound access to
employer sites, which is Hour 1 above. Expect to fix a token or two on the first
real crawl.

The unsupported tier is where most of your actual targets live. Two ways
forward once the core is running:

1. **Adapters.** Paylocity and JazzHR both have parseable JSON behind their
   job list pages — each is maybe an hour. iCIMS and ADP are HTML scrapes.
2. **Change-detection fallback.** For any careers page with no ATS at all,
   hash the page text daily and alert on change. Crude, but it catches a new
   posting at a 40-person family distributor the same day it goes up, which
   is exactly the posting nobody else is seeing.

Option 2 is the one worth building next. It's simpler than the adapters and
it covers the companies that matter most to you.
