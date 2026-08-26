-- ============================================================
-- JobScout — keep the page current.
--
-- NOT YET APPLIED. Applying it is a decision, per the standing rule.
--
-- The page is a file now, written by jobscout-dashboard when cron pokes it.
-- Without these entries the file is only rewritten when Keith clicks a button,
-- which means the morning crawl would find three new roles and the page would
-- still show yesterday's. A dashboard that is silently one run behind is worse
-- than no dashboard: it reads as "nothing new today".
--
-- Each publish runs AFTER the run whose results it is meant to show. It costs
-- nothing — no crawling, no model calls, one render and one file write.
-- ============================================================

-- 15 minutes after each scoring run, which is itself 25 minutes after ingest.
select cron.schedule('jobscout-publish-am', '50 10 * * *', $$select jobscout.kick('jobscout-dashboard')$$);
select cron.schedule('jobscout-publish-pm', '50 22 * * *', $$select jobscout.kick('jobscout-dashboard')$$);

-- And after discovery, because a newly-crawlable employer changes the coverage
-- panel — the one that says how much of the target list is actually watched.
select cron.schedule('jobscout-publish-discover', '10 8 * * *', $$select jobscout.kick('jobscout-dashboard')$$);

-- To stop everything:
--   select cron.unschedule(jobname) from cron.job where jobname like 'jobscout-%';
