"""Stage-1 filter tests and the stale-posting close path. No network."""
import unittest
from unittest import mock

import ingest
import score


class TitleFilter(unittest.TestCase):
    KEEP = ["Director of Operations", "Plant Manager", "VP, Supply Chain",
            "Distribution Center Supervisor", "Operations Manager",
            "Warehouse Operations Manager", "Terminal Manager",
            "Continuous Improvement Manager", "Fleet Maintenance Supervisor",
            "Operational Excellence Lead"]
    DROP = ["Warehouse Associate", "CDL Driver", "Software Engineer",
            "Seasonal Picker", "Associate Director of Logistics",
            "Manufacturing Engineer I", "Manufacturing Engineer II",
            "Registered Nurse", "Part-Time Dispatcher",
            "Accounts Payable Clerk", "Marketing Manager"]

    def test_keeps(self):
        for t in self.KEEP:
            self.assertTrue(score.title_ok(t), t)

    def test_drops(self):
        for t in self.DROP:
            self.assertFalse(score.title_ok(t), t)

    def test_whole_word_not_substring(self):
        # The bug this replaced: "associate " never matched a trailing
        # "Associate", so every warehouse-associate posting reached the model.
        self.assertFalse(score.title_ok("Warehouse Associate"))
        # ...and the inverse: a substring match must not kill a real title.
        self.assertTrue(score.title_ok("Associated Grocers Operations Manager"))


class LocationFilter(unittest.TestCase):
    def test_gate(self):
        for loc in ["Buffalo, NY", "Remote", "Amherst", "Western New York"]:
            self.assertTrue(score.location_ok(loc), loc)
        for loc in ["Dallas, TX", "Chicago, IL"]:
            self.assertFalse(score.location_ok(loc), loc)

    def test_unknown_location_passes_through(self):
        # Unknown location is not a reason to spend nothing — let the model see it.
        self.assertTrue(score.location_ok(None))
        self.assertTrue(score.location_ok(""))


class FakeSupa:
    """Records what ingest.run would write."""
    def __init__(self, companies, upsert_ok=True, stale=1):
        self.companies, self.upsert_ok, self.stale = companies, upsert_ok, stale
        self.upserted, self.patched = [], []

    def select(self, table, params):
        return self.companies

    def upsert(self, table, rows, on_conflict):
        self.upserted.append((table, rows))
        return self.upsert_ok

    def patch(self, table, params, values):
        self.patched.append((table, params, values))
        return [{"id": i} for i in range(self.stale)]


COMPANY = [{"id": 7, "name": "Acme", "ats": "greenhouse", "board_token": "acme"}]
POSTING = [{"ats_job_id": "1", "title": "Operations Manager", "location": "Buffalo, NY",
            "url": "https://x", "description": "d", "posted_at": None}]


class StaleClosing(unittest.TestCase):
    def _run(self, supa, dry=False):
        with mock.patch.object(ingest, "Supa", lambda: supa), \
             mock.patch.dict(ingest.ADAPTERS, {"greenhouse": lambda c: POSTING}):
            ingest.run(dry=dry)

    def test_closes_postings_that_vanished_from_the_board(self):
        supa = FakeSupa(COMPANY)
        self._run(supa)
        self.assertEqual(len(supa.patched), 1)
        table, params, values = supa.patched[0]
        self.assertEqual(table, "jobs")
        self.assertEqual(values, {"is_open": False})
        self.assertEqual(params["company_id"], "eq.7")
        self.assertEqual(params["is_open"], "eq.true")
        # Scoped by last_seen so only untouched rows close.
        self.assertTrue(params["last_seen"].startswith("lt."))

    def test_failed_upsert_never_closes_the_board(self):
        supa = FakeSupa(COMPANY, upsert_ok=False)
        self._run(supa)
        self.assertEqual(supa.patched, [],
                         "a failed write must not close every posting")

    def test_fetch_error_never_closes_the_board(self):
        supa = FakeSupa(COMPANY)
        def boom(c):
            raise RuntimeError("board timed out")
        with mock.patch.object(ingest, "Supa", lambda: supa), \
             mock.patch.dict(ingest.ADAPTERS, {"greenhouse": boom}):
            ingest.run()
        self.assertEqual(supa.patched, [])
        self.assertEqual(supa.upserted, [])

    def test_dry_run_writes_nothing(self):
        supa = FakeSupa(COMPANY)
        self._run(supa, dry=True)
        self.assertEqual(supa.upserted, [])
        self.assertEqual(supa.patched, [])


if __name__ == "__main__":
    unittest.main()
