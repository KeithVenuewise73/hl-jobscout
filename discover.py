#!/usr/bin/env python3
"""
JobScout discover — point it at an employer's careers page and it tells you
which ATS they run and the board token ingest.py needs.

This is the step that turns a list of company names into a working crawler.

Usage:
    python discover.py --csv seed_companies.csv --out companies_resolved.csv
    python discover.py --url https://www.example.com/careers
"""

import argparse
import csv
import re
import sys
import time
from urllib.parse import urlparse

import requests

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}

# Each pattern pulls the board token out of whatever URL the page links to.
SIGNATURES = [
    ("greenhouse",      r"(?:boards|job-boards)\.greenhouse\.io/(?:embed/job_board\?for=)?([a-zA-Z0-9_-]+)"),
    ("lever",           r"jobs\.lever\.co/([a-zA-Z0-9_-]+)"),
    ("ashby",           r"jobs\.ashbyhq\.com/([a-zA-Z0-9_-]+)"),
    ("smartrecruiters", r"(?:jobs|careers)\.smartrecruiters\.com/([a-zA-Z0-9_-]+)"),
    ("workday",         r"([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([a-zA-Z0-9_-]+)"),
    ("icims",           r"([a-zA-Z0-9-]+)\.icims\.com"),
    ("paylocity",       r"recruiting\.paylocity\.com/recruiting/jobs/List/(\d+)"),
    ("adp",             r"workforcenow\.adp\.com/(?:mascsr/default/mdf/recruitment/recruitment\.html\?cid=)?([a-f0-9-]{20,})"),
    ("ukg",             r"([a-zA-Z0-9-]+)\.(?:ultipro|ukg)\.com"),
    ("jazzhr",          r"([a-zA-Z0-9-]+)\.applytojob\.com"),
    ("bamboohr",        r"([a-zA-Z0-9-]+)\.bamboohr\.com/(?:jobs|careers)"),
    ("paycom",          r"paycomonline\.net/v4/ats/web\.php/jobs\?clientkey=([A-F0-9]+)"),
    ("taleo",           r"([a-zA-Z0-9-]+)\.taleo\.net"),
    ("recruitee",       r"([a-zA-Z0-9-]+)\.recruitee\.com"),
    ("workable",        r"apply\.workable\.com/([a-zA-Z0-9_-]+)"),
]

# ATS we can ingest today via JSON. Everything else needs a custom adapter.
SUPPORTED = {"greenhouse", "lever", "ashby", "smartrecruiters", "workday"}

CAREER_HINTS = ["/careers", "/career", "/jobs", "/join-us", "/employment",
                "/work-with-us", "/opportunities", "/about/careers"]


def unresolved(evidence, **extra):
    """The shape every caller can rely on: ats/board_token/supported always set."""
    rec = {"ats": "unknown", "board_token": None, "supported": False,
           "evidence": evidence}
    rec.update(extra)
    return rec


def probe(url):
    """Fetch a page and look for ATS fingerprints in the HTML."""
    try:
        r = requests.get(url, headers=UA, timeout=20, allow_redirects=True)
    except Exception as e:
        return unresolved(f"{type(e).__name__} fetching {url}")
    html = r.text
    final = r.url

    for ats, pat in SIGNATURES:
        m = re.search(pat, html) or re.search(pat, final)
        if not m:
            continue
        rec = {"ats": ats, "board_token": m.group(1), "evidence": m.group(0)[:120]}
        if ats == "workday":
            rec["board_token"] = m.group(1)
            rec["workday_host"] = f"{m.group(1)}.{m.group(2)}.myworkdayjobs.com"
            rec["workday_site"] = m.group(3)
        rec["supported"] = ats in SUPPORTED
        return rec

    # No ATS fingerprint. Is there at least a jobs page worth a manual look?
    return unresolved(f"no ATS signature at {final}")


def find_careers_page(root):
    """Given a company homepage, try the usual careers paths."""
    p = urlparse(root if root.startswith("http") else "https://" + root)
    base = f"{p.scheme}://{p.netloc}"
    # first: does the homepage itself already link an ATS?
    res = probe(base)
    if res["ats"] != "unknown":
        res["careers_url"] = base
        return res
    for hint in CAREER_HINTS:
        u = base + hint
        try:
            head = requests.head(u, headers=UA, timeout=10, allow_redirects=True)
            if head.status_code >= 400:
                continue
        except Exception:
            continue
        res = probe(u)
        res["careers_url"] = u
        if res["ats"] != "unknown":
            return res
    return unresolved("no careers page found", careers_url=base)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--csv", help="input CSV with name,website columns")
    ap.add_argument("--out", default="companies_resolved.csv")
    a = ap.parse_args()

    if a.url:
        print(find_careers_page(a.url))
        return

    if not a.csv:
        sys.exit("need --url or --csv")

    rows = list(csv.DictReader(open(a.csv)))
    out = []
    for i, row in enumerate(rows, 1):
        site = (row.get("website") or "").strip()
        if not site:
            continue
        res = find_careers_page(site)
        merged = {**row, **res}
        out.append(merged)
        flag = "OK " if res.get("supported") else "-- "
        print(f"{flag}[{i}/{len(rows)}] {row.get('name','?'):<38} "
              f"{res.get('ats'):<16} {res.get('board_token') or ''}")
        time.sleep(0.5)

    cols = ["name", "website", "careers_url", "ats", "board_token",
            "workday_host", "workday_site", "supported", "city", "state",
            "size_band", "owner_type", "priority", "evidence", "notes"]
    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(out)

    sup = sum(1 for r in out if r.get("supported"))
    print(f"\n{sup}/{len(out)} ingestible today. "
          f"The rest need a manual adapter or a bookmark.")


if __name__ == "__main__":
    main()
