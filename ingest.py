#!/usr/bin/env python3
"""
JobScout ingest — pull job postings directly from employer career boards.

No LinkedIn, no Indeed. Each adapter talks to the ATS the employer already runs.

Usage:
    export SUPABASE_URL="https://xxxx.supabase.co"
    export SUPABASE_SERVICE_KEY="eyJ..."
    python ingest.py              # all active companies
    python ingest.py --ats lever  # one ATS at a time
    python ingest.py --dry-run    # print, don't write
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; JobScout/1.0)"}
TIMEOUT = 25


# ------------------------------------------------------------------
# Supabase REST helpers (no extra deps — just requests)
# ------------------------------------------------------------------
class Supa:
    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_KEY"]
        self.h = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept-Profile": "jobscout",
            "Content-Profile": "jobscout",
        }

    def select(self, table, params):
        r = requests.get(f"{self.url}/rest/v1/{table}", headers=self.h,
                         params=params, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()

    def upsert(self, table, rows, on_conflict):
        """Returns True on success. Callers key stale-closing off this."""
        if not rows:
            return True
        h = dict(self.h)
        h["Prefer"] = "resolution=merge-duplicates,return=minimal"
        r = requests.post(f"{self.url}/rest/v1/{table}", headers=h,
                          params={"on_conflict": on_conflict},
                          data=json.dumps(rows), timeout=60)
        if r.status_code >= 300:
            print(f"  ! upsert {table}: {r.status_code} {r.text[:300]}")
            return False
        return True

    def patch(self, table, params, values):
        h = dict(self.h)
        h["Prefer"] = "return=representation"
        r = requests.patch(f"{self.url}/rest/v1/{table}", headers=h,
                           params=params, data=json.dumps(values), timeout=60)
        if r.status_code >= 300:
            print(f"  ! patch {table}: {r.status_code} {r.text[:300]}")
            return []
        return r.json()


def strip_html(s):
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</(p|div|li|h\d)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = (s.replace("&amp;", "&").replace("&nbsp;", " ")
          .replace("&#39;", "'").replace("&quot;", '"')
          .replace("&lt;", "<").replace("&gt;", ">"))
    return re.sub(r"[ \t]{2,}", " ", s).strip()


def iso(ts):
    """Normalize whatever the ATS gave us into an ISO timestamp or None."""
    if not ts:
        return None
    if isinstance(ts, (int, float)):
        # Greenhouse/Lever use epoch millis
        if ts > 1e12:
            ts = ts / 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    s = str(ts).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).isoformat()
    except ValueError:
        return None


# ------------------------------------------------------------------
# Adapters — each returns a list of normalized dicts
# ------------------------------------------------------------------
def fetch_greenhouse(c):
    tok = c["board_token"]
    u = f"https://boards-api.greenhouse.io/v1/boards/{tok}/jobs?content=true"
    d = requests.get(u, headers=UA, timeout=TIMEOUT).json()
    out = []
    for j in d.get("jobs", []):
        out.append({
            "ats_job_id": str(j["id"]),
            "title": j.get("title", ""),
            "location": (j.get("location") or {}).get("name"),
            "department": None,
            "url": j.get("absolute_url"),
            "description": strip_html(j.get("content")),
            "posted_at": iso(j.get("updated_at") or j.get("first_published")),
        })
    return out


def fetch_lever(c):
    tok = c["board_token"]
    u = f"https://api.lever.co/v0/postings/{tok}?mode=json"
    d = requests.get(u, headers=UA, timeout=TIMEOUT).json()
    out = []
    for j in d:
        cat = j.get("categories") or {}
        out.append({
            "ats_job_id": str(j.get("id")),
            "title": j.get("text", ""),
            "location": cat.get("location"),
            "department": cat.get("department") or cat.get("team"),
            "url": j.get("hostedUrl"),
            "description": strip_html(
                (j.get("descriptionPlain") or j.get("description") or "") + "\n" +
                "\n".join(strip_html(l.get("text", "")) + "\n" +
                          strip_html(str(l.get("content", "")))
                          for l in (j.get("lists") or []))
            ),
            "posted_at": iso(j.get("createdAt")),
        })
    return out


def fetch_ashby(c):
    tok = c["board_token"]
    u = (f"https://api.ashbyhq.com/posting-api/job-board/{tok}"
         f"?includeCompensation=true")
    d = requests.get(u, headers=UA, timeout=TIMEOUT).json()
    out = []
    for j in d.get("jobs", []):
        out.append({
            "ats_job_id": str(j.get("id")),
            "title": j.get("title", ""),
            "location": j.get("location"),
            "department": j.get("department") or j.get("team"),
            "url": j.get("jobUrl"),
            "description": strip_html(j.get("descriptionHtml") or j.get("descriptionPlain")),
            "comp_text": (j.get("compensation") or {}).get("compensationTierSummary"),
            "posted_at": iso(j.get("publishedAt")),
        })
    return out


def fetch_smartrecruiters(c):
    tok = c["board_token"]
    out, offset = [], 0
    while True:
        u = (f"https://api.smartrecruiters.com/v1/companies/{tok}/postings"
             f"?limit=100&offset={offset}")
        d = requests.get(u, headers=UA, timeout=TIMEOUT).json()
        items = d.get("content", [])
        for j in items:
            loc = j.get("location") or {}
            out.append({
                "ats_job_id": str(j.get("id")),
                "title": j.get("name", ""),
                "location": ", ".join(x for x in [loc.get("city"), loc.get("region")] if x),
                "department": (j.get("department") or {}).get("label"),
                "url": f"https://jobs.smartrecruiters.com/{tok}/{j.get('id')}",
                "description": None,   # detail call needed; fetched lazily below
                "posted_at": iso(j.get("releasedDate")),
            })
        offset += len(items)
        if len(items) < 100 or offset >= d.get("totalFound", 0):
            break
    # pull descriptions (SmartRecruiters keeps them on the detail endpoint)
    for row in out:
        try:
            det = requests.get(
                f"https://api.smartrecruiters.com/v1/companies/{tok}/postings/{row['ats_job_id']}",
                headers=UA, timeout=TIMEOUT).json()
            secs = (det.get("jobAd") or {}).get("sections") or {}
            row["description"] = strip_html(" ".join(
                (secs.get(k) or {}).get("text", "")
                for k in ("companyDescription", "jobDescription", "qualifications", "additionalInformation")
            ))
            time.sleep(0.2)
        except Exception:
            pass
    return out


def fetch_workday(c):
    """Workday has no public API, but its own front end POSTs to this endpoint."""
    host = c.get("workday_host")          # e.g. wd1.myworkdayjobs.com
    tenant = c["board_token"]             # e.g. richproducts
    site = c.get("workday_site") or "External"
    base = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    out, offset = [], 0
    while True:
        body = {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": ""}
        r = requests.post(base, json=body, headers={**UA, "Accept": "application/json"},
                          timeout=TIMEOUT)
        if r.status_code >= 300:
            print(f"  ! workday {tenant}: {r.status_code}")
            break
        d = r.json()
        posts = d.get("jobPostings", [])
        for j in posts:
            path = j.get("externalPath", "")
            out.append({
                "ats_job_id": path or j.get("bulletFields", [""])[0],
                "title": j.get("title", ""),
                "location": j.get("locationsText"),
                "department": None,
                "url": f"https://{host}/{'/'.join(filter(None, [tenant, site]))}{path}"
                       if not path.startswith("http") else path,
                "description": None,
                "posted_at": None,
            })
        offset += len(posts)
        if len(posts) < 20 or offset >= d.get("total", 0):
            break
    # descriptions live on a per-job endpoint
    for row in out:
        p = row["ats_job_id"]
        if not p.startswith("/"):
            continue
        try:
            det = requests.get(f"https://{host}/wday/cxs/{tenant}/{site}{p}",
                               headers={**UA, "Accept": "application/json"},
                               timeout=TIMEOUT).json()
            ji = det.get("jobPostingInfo", {})
            row["description"] = strip_html(ji.get("jobDescription"))
            row["posted_at"] = iso(ji.get("startDate"))
            row["url"] = ji.get("externalUrl") or row["url"]
            time.sleep(0.3)
        except Exception:
            pass
    return out


ADAPTERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "smartrecruiters": fetch_smartrecruiters,
    "workday": fetch_workday,
}


# ------------------------------------------------------------------
def run(only_ats=None, dry=False):
    supa = Supa()
    params = {"select": "*", "active": "eq.true", "order": "priority.asc"}
    if only_ats:
        params["ats"] = f"eq.{only_ats}"
    companies = supa.select("companies", params)
    print(f"{len(companies)} active companies\n")

    total_new = 0
    total_closed = 0
    for c in companies:
        fn = ADAPTERS.get((c.get("ats") or "").lower())
        if not fn or not c.get("board_token"):
            continue
        # Stamped before the fetch, so anything this run touches sorts after it.
        run_start = datetime.now(timezone.utc).isoformat()
        try:
            postings = fn(c)
        except Exception as e:
            print(f"  ! {c['name']} ({c['ats']}): {type(e).__name__}: {e}")
            continue

        rows = []
        now = datetime.now(timezone.utc).isoformat()
        for p in postings:
            if not p.get("ats_job_id"):
                continue
            rows.append({
                "company_id": c["id"],
                "ats_job_id": p["ats_job_id"],
                "title": p["title"][:400],
                "location": (p.get("location") or "")[:300] or None,
                "department": p.get("department"),
                "url": p.get("url"),
                "description": (p.get("description") or "")[:40000] or None,
                "comp_text": p.get("comp_text"),
                "posted_at": p.get("posted_at"),
                "last_seen": now,
                "is_open": True,
            })

        total_new += len(rows)
        closed = 0
        if not dry:
            # Only close stale postings if the write actually landed — a failed
            # upsert would otherwise close the whole board.
            if supa.upsert("jobs", rows, on_conflict="company_id,ats_job_id"):
                closed = len(supa.patch(
                    "jobs",
                    {"company_id": f"eq.{c['id']}", "is_open": "eq.true",
                     "last_seen": f"lt.{run_start}", "select": "id"},
                    {"is_open": False},
                ))
                total_closed += closed
        note = f"  ({closed} closed)" if closed else ""
        print(f"  {c['name']:<38} {c['ats']:<16} {len(rows):>4} postings{note}")

    print(f"\ntotal postings seen: {total_new}")
    if dry:
        print("(dry run — nothing written, nothing closed)")
    else:
        print(f"postings closed (gone from the board): {total_closed}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ats")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    try:
        run(a.ats, a.dry_run)
    except KeyError as e:
        sys.exit(f"missing env var: {e}")
