-- A SECOND token, for reading rather than running.
--
-- The dashboard is opened in a browser from a bookmark, so its credential
-- travels in the URL and ends up in history, in a synced profile, in the
-- occasional screenshot. The cron token must never be that: whoever holds it
-- can start crawls and scoring runs, which cost money.
--
-- So the view token is separate and strictly weaker. It reads the shortlist and
-- marks a job applied. It cannot start anything.
alter table jobscout.runtime
  add column if not exists view_token text not null
    default encode(extensions.gen_random_bytes(24), 'hex');
