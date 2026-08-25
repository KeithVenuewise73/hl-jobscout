"""Adapter parsing tests — recorded ATS payloads, no network.

These prove the field mapping, not the live boards. A board that changes its
JSON shape will still break ingest and these tests will still pass; the only
thing that catches that is a real run.
"""
import unittest
from unittest import mock

import ingest


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p


def route(table):
    """Return a fake requests.get/post that serves payloads by URL substring."""
    def _fn(url, *_, **__):
        for frag, payload in table.items():
            if frag in url:
                return FakeResp(payload)
        raise AssertionError(f"unexpected request: {url}")
    return _fn


class Greenhouse(unittest.TestCase):
    def test_maps_fields(self):
        payload = {"jobs": [{
            "id": 4001, "title": "Director of Operations",
            "location": {"name": "Buffalo, NY"},
            "absolute_url": "https://boards.greenhouse.io/acme/jobs/4001",
            "content": "<p>Run the DC.</p>",
            "updated_at": "2026-02-01T12:00:00Z",
        }]}
        with mock.patch.object(ingest.requests, "get", route({"greenhouse": payload})):
            rows = ingest.fetch_greenhouse({"board_token": "acme"})
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["ats_job_id"], "4001")          # coerced to text
        self.assertEqual(r["title"], "Director of Operations")
        self.assertEqual(r["location"], "Buffalo, NY")
        self.assertEqual(r["description"], "Run the DC.")   # html stripped
        self.assertTrue(r["posted_at"].startswith("2026-02-01T12:00:00"))


class Lever(unittest.TestCase):
    def test_maps_fields_and_epoch_millis(self):
        payload = [{
            "id": "abc-123", "text": "Plant Manager",
            "categories": {"location": "Lancaster, NY", "department": "Ops"},
            "hostedUrl": "https://jobs.lever.co/acme/abc-123",
            "descriptionPlain": "Own the plant.",
            "lists": [{"text": "Requirements", "content": "<li>5 years</li>"}],
            "createdAt": 1735689600000,
        }]
        with mock.patch.object(ingest.requests, "get", route({"lever": payload})):
            rows = ingest.fetch_lever({"board_token": "acme"})
        r = rows[0]
        self.assertEqual(r["ats_job_id"], "abc-123")
        self.assertEqual(r["department"], "Ops")
        self.assertIn("Own the plant.", r["description"])
        self.assertIn("5 years", r["description"])
        self.assertEqual(r["posted_at"], "2025-01-01T00:00:00+00:00")


class Ashby(unittest.TestCase):
    def test_captures_compensation(self):
        payload = {"jobs": [{
            "id": "j1", "title": "Site Manager", "location": "Amherst, NY",
            "department": "Operations", "jobUrl": "https://jobs.ashbyhq.com/acme/j1",
            "descriptionHtml": "<p>Lead the site.</p>",
            "compensation": {"compensationTierSummary": "$95K – $115K"},
            "publishedAt": "2026-03-05T09:00:00Z",
        }]}
        with mock.patch.object(ingest.requests, "get", route({"ashbyhq": payload})):
            rows = ingest.fetch_ashby({"board_token": "acme"})
        r = rows[0]
        self.assertEqual(r["comp_text"], "$95K – $115K")
        self.assertEqual(r["description"], "Lead the site.")


class SmartRecruiters(unittest.TestCase):
    def test_pages_then_fetches_descriptions(self):
        listing = {"content": [{
            "id": "sr1", "name": "Branch Manager",
            "location": {"city": "Rochester", "region": "NY"},
            "department": {"label": "Field Ops"},
            "releasedDate": "2026-01-15T00:00:00Z",
        }], "totalFound": 1}
        detail = {"jobAd": {"sections": {
            "jobDescription": {"text": "<p>Run the branch.</p>"},
            "qualifications": {"text": "<p>10 years.</p>"},
        }}}
        # The detail URL is the listing URL plus /sr1, so order matters here.
        def _get(url, *_, **__):
            return FakeResp(detail if url.endswith("/sr1") else listing)
        with mock.patch.object(ingest.requests, "get", _get):
            rows = ingest.fetch_smartrecruiters({"board_token": "acme"})
        r = rows[0]
        self.assertEqual(r["location"], "Rochester, NY")
        self.assertEqual(r["department"], "Field Ops")
        self.assertIn("Run the branch.", r["description"])
        self.assertIn("10 years.", r["description"])


class Workday(unittest.TestCase):
    def test_uses_external_path_as_id(self):
        listing = {"jobPostings": [{
            "title": "Operations Manager", "externalPath": "/job/Buffalo/Ops_R-1",
            "locationsText": "Buffalo, NY", "bulletFields": ["R-1"],
        }], "total": 1}
        detail = {"jobPostingInfo": {
            "jobDescription": "<p>Own throughput.</p>",
            "startDate": "2026-04-01T00:00:00Z",
            "externalUrl": "https://acme.wd1.myworkdayjobs.com/en-US/External/job/R-1",
        }}
        company = {"board_token": "acme", "workday_host": "acme.wd1.myworkdayjobs.com",
                   "workday_site": "External"}
        with mock.patch.object(ingest.requests, "post", route({"/jobs": listing})), \
             mock.patch.object(ingest.requests, "get", route({"Ops_R-1": detail})):
            rows = ingest.fetch_workday(company)
        r = rows[0]
        self.assertEqual(r["ats_job_id"], "/job/Buffalo/Ops_R-1")
        self.assertEqual(r["description"], "Own throughput.")
        self.assertEqual(r["url"], detail["jobPostingInfo"]["externalUrl"])


class Helpers(unittest.TestCase):
    def test_strip_html(self):
        self.assertEqual(ingest.strip_html("<p>a&nbsp;<b>b</b></p><br/>c&amp;d"),
                         "a b \n\nc&d")
        self.assertEqual(ingest.strip_html(None), "")

    def test_iso(self):
        self.assertEqual(ingest.iso(1735689600000), "2025-01-01T00:00:00+00:00")
        self.assertEqual(ingest.iso("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00+00:00")
        self.assertIsNone(ingest.iso("not a date"))
        self.assertIsNone(ingest.iso(None))


if __name__ == "__main__":
    unittest.main()
