#!/usr/bin/env python3
"""
JobScout score — match open postings against the resume.

Two stages, on purpose:
  1. Cheap SQL-side filters kill 90% of postings for free (geography, title,
     obvious mismatches). No API calls burned on warehouse associate roles.
  2. Survivors get read by Claude, which scores fit 0-100 and — the part that
     actually matters — writes the angle for pitching this specific resume
     at this specific job.

Usage:
    export SUPABASE_URL=... SUPABASE_SERVICE_KEY=... ANTHROPIC_API_KEY=...
    python score.py --resume "keith-ops-2026"
    python score.py --resume "keith-ops-2026" --rescore   # ignore existing scores
"""

import argparse
import json
import os
import re
import sys

import anthropic
import requests

MODEL = "claude-opus-5"
TIMEOUT = 120

# ---- stage 1: hard filters -------------------------------------------------
# Tune these. They run before a single token is spent.

TITLE_INCLUDE = [
    "operations", "operation", "plant", "production", "warehouse", "distribution",
    "logistics", "supply chain", "transportation", "fleet", "dispatch",
    "general manager", "site manager", "branch manager", "facility", "facilities",
    "field service", "service manager", "terminal", "director", "vp",
    "continuous improvement", "process improvement", "3pl", "last mile",
    "final mile", "delivery", "shipping", "receiving", "inventory",
]

# Matched as whole words, so "associate" kills "Warehouse Associate" without
# also killing "Associated Distributors". Widen or trim as calibration demands.
TITLE_EXCLUDE = [
    "intern", "internship", "associate", "clerk", "driver", "cdl",
    "technician", "engineer i", "software", "nurse", "rn", "physician",
    "sales representative", "cashier", "part-time", "part time", "seasonal",
    "loader", "unloader", "picker", "packer", "custodian", "janitor",
    "entry level", "apprentice", "co-op",
]

# Location gate — Buffalo/WNY commutable plus remote.
LOCATION_OK = [
    "buffalo", "amherst", "cheektowaga", "tonawanda", "lancaster", "depew",
    "west seneca", "hamburg", "orchard park", "lackawanna", "niagara",
    "lockport", "batavia", "rochester", "olean", "jamestown", "dunkirk",
    "fredonia", "wny", "western new york", "remote", "erie county",
    "new york", " ny", "ny,", "ny ",
]


# Whole-word matching. Substring matching is what makes keyword filters lie:
# "associate " never matches a title that ends in "Associate", and "vp " never
# matches "VP".
EXCLUDE_RE = re.compile(
    r"\b(?:%s)\b" % "|".join(re.escape(x) for x in TITLE_EXCLUDE), re.I)
INCLUDE_RE = re.compile(
    r"\b(?:%s)" % "|".join(re.escape(x) for x in TITLE_INCLUDE), re.I)


def title_ok(t):
    t = t or ""
    if EXCLUDE_RE.search(t):
        return False
    return bool(INCLUDE_RE.search(t))


def location_ok(loc):
    if not loc:
        return True          # unknown location — let Claude decide
    l = loc.lower()
    return any(x in l for x in LOCATION_OK)


# ---- supabase --------------------------------------------------------------
class Supa:
    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_KEY"]
        self.h = {"apikey": key, "Authorization": f"Bearer {key}",
                  "Content-Type": "application/json",
                  "Accept-Profile": "jobscout", "Content-Profile": "jobscout"}

    def select(self, table, params):
        r = requests.get(f"{self.url}/rest/v1/{table}", headers=self.h,
                         params=params, timeout=60)
        r.raise_for_status()
        return r.json()

    def upsert(self, table, rows, on_conflict):
        if not rows:
            return
        h = dict(self.h)
        h["Prefer"] = "resolution=merge-duplicates"
        r = requests.post(f"{self.url}/rest/v1/{table}", headers=h,
                          params={"on_conflict": on_conflict},
                          data=json.dumps(rows), timeout=60)
        if r.status_code >= 300:
            print(f"  ! {r.status_code} {r.text[:300]}")


# ---- stage 2: Claude scoring ----------------------------------------------
SYSTEM = """You screen job postings for one specific candidate. You are blunt and \
calibrated — most postings are a 40, a real match is rare. Inflated scores make \
the tool useless.

Score on:
- Does his actual operating experience map to what this job runs day to day?
- Is the scope right — enough autonomy and P&L to be interesting, not so big it's
  a turnaround grind?
- Employer shape: small/single-site/private/family-owned scores higher than a
  layer deep inside a large public company.
- Compensation: if the posting states pay below his floor, cap the score at 25.
- If the posting has no description, score on title and employer only and cap at 55.

why_not is the real risk or gap, not a hedge. resume_angle is the specific
experience to lead with in the first line of a cover letter for THIS job —
leave it empty when the verdict is pass."""

# The API validates against this, so there is no JSON to repair on our side.
SCHEMA = {
    "type": "object",
    "properties": {
        "fit_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "verdict": {"type": "string", "enum": ["apply", "maybe", "pass"]},
        "why_fits": {"type": "string"},
        "why_not": {"type": "string"},
        "resume_angle": {"type": "string"},
    },
    "required": ["fit_score", "verdict", "why_fits", "why_not", "resume_angle"],
    "additionalProperties": False,
}


def resume_block(resume):
    """The stable prefix — identical for every posting in a run, so it caches."""
    return f"""CANDIDATE RESUME
{resume['content']}

COMPENSATION FLOOR: ${resume.get('comp_floor') or 0:,}/yr
MUST HAVE: {', '.join(resume.get('must_have') or []) or 'none stated'}
DEALBREAKERS: {', '.join(resume.get('dealbreakers') or []) or 'none stated'}"""


def score_one(client, prefix, job, company, effort):
    posting = f"""---
EMPLOYER: {company['name']} | {company.get('city') or '?'}, {company.get('state') or ''} \
| {company.get('owner_type') or 'unknown ownership'} | {company.get('size_band') or 'unknown size'}

POSTING TITLE: {job['title']}
LOCATION: {job.get('location') or 'not stated'}
STATED PAY: {job.get('comp_text') or 'not stated'}

DESCRIPTION:
{job.get('description') or '(no description available)'}"""

    r = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        system=SYSTEM,
        messages=[{"role": "user", "content": [
            # cache_control ends the cached prefix here: system + resume are
            # byte-identical across every posting, so only the posting is new.
            {"type": "text", "text": prefix,
             "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": posting},
        ]}],
        output_config={
            "effort": effort,
            "format": {"type": "json_schema", "schema": SCHEMA},
        },
    )
    if r.stop_reason == "refusal":
        raise RuntimeError(f"refused: {getattr(r.stop_details, 'category', None)}")
    text = next(b.text for b in r.content if b.type == "text")
    return json.loads(text), r.usage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", required=True)
    ap.add_argument("--rescore", action="store_true")
    ap.add_argument("--limit", type=int, default=250)
    ap.add_argument("--effort", default="medium",
                    choices=["low", "medium", "high", "xhigh", "max"],
                    help="how hard the model thinks per posting (cost knob)")
    a = ap.parse_args()

    supa = Supa()
    client = anthropic.Anthropic(timeout=TIMEOUT)
    rs = supa.select("resumes", {"select": "*", "label": f"eq.{a.resume}"})
    if not rs:
        sys.exit(f"no resume labeled '{a.resume}' — insert one first")
    resume = rs[0]

    companies = {c["id"]: c for c in supa.select("companies", {"select": "*"})}
    jobs = supa.select("jobs", {"select": "*", "is_open": "eq.true",
                                "order": "first_seen.desc", "limit": "2000"})

    already = set()
    if not a.rescore:
        already = {s["job_id"] for s in supa.select(
            "scores", {"select": "job_id", "resume_id": f"eq.{resume['id']}"})}

    unscored = [j for j in jobs if j["id"] not in already]
    eligible = [j for j in unscored
                if title_ok(j["title"]) and location_ok(j.get("location"))]
    queue = eligible[:a.limit]

    print(f"{len(jobs)} open postings | {len(jobs) - len(unscored)} already scored | "
          f"{len(unscored) - len(eligible)} filtered out free | "
          f"{len(queue)} going to Claude")
    if len(eligible) > len(queue):
        print(f"({len(eligible) - len(queue)} eligible postings held back by "
              f"--limit {a.limit} — re-run to pick them up)")
    print()

    prefix = resume_block(resume)
    batch, cached_in, fresh_in, out = [], 0, 0, 0
    for i, j in enumerate(queue, 1):
        co = companies.get(j["company_id"], {"name": "?"})
        try:
            s, usage = score_one(client, prefix, j, co, a.effort)
        except Exception as e:
            print(f"  ! {j['title'][:50]}: {type(e).__name__}: {e}")
            continue
        cached_in += usage.cache_read_input_tokens or 0
        fresh_in += usage.input_tokens + (usage.cache_creation_input_tokens or 0)
        out += usage.output_tokens
        batch.append({
            "job_id": j["id"], "resume_id": resume["id"],
            "fit_score": int(s.get("fit_score", 0)),
            "verdict": s.get("verdict"),
            "why_fits": s.get("why_fits"),
            "why_not": s.get("why_not"),
            "resume_angle": s.get("resume_angle"),
            "model": MODEL,
        })
        mark = {"apply": ">>", "maybe": " ~", "pass": "  "}.get(s.get("verdict"), "  ")
        print(f"{mark} {s.get('fit_score'):>3}  [{i:>3}/{len(queue)}]  "
              f"{co['name'][:22]:<22} {j['title'][:46]}")
        if len(batch) >= 25:
            supa.upsert("scores", batch, "job_id,resume_id")
            batch = []

    supa.upsert("scores", batch, "job_id,resume_id")
    print(f"\ntokens — {fresh_in:,} in / {cached_in:,} cached / {out:,} out")
    print("done — open the dashboard or query jobscout.v_shortlist")


if __name__ == "__main__":
    main()
