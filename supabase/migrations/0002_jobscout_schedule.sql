-- ============================================================
-- JobScout — the schedule.
--
-- SEPARATE from 0001 on purpose. 0001 only creates tables; this one turns the
-- machine on. Applying it means JobScout starts crawling employer sites and
-- spending Anthropic tokens twice a day, so it is its own approval.
--
-- Requires, before this runs:
--   * the jobscout-ingest / jobscout-score edge functions deployed
--   * ANTHROPIC_API_KEY set as an edge function secret
--   * app.settings.jobscout_functions_url and .service_role_key set (below)
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Where the functions live and how to authenticate to them. Set once:
--   alter database postgres set app.settings.jobscout_functions_url =
--     'https://<project-ref>.supabase.co/functions/v1';
--   alter database postgres set app.settings.jobscout_service_role_key = '<key>';
create or replace function jobscout.kick(fn text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text := current_setting('app.settings.jobscout_functions_url', true);
  key  text := current_setting('app.settings.jobscout_service_role_key', true);
begin
  if base is null or key is null then
    -- Fail loudly. A schedule that silently does nothing is the worst outcome:
    -- it reads as "running" on every dashboard while nothing is crawled.
    raise exception 'jobscout.kick: app.settings.jobscout_functions_url / _service_role_key not set';
  end if;
  return net.http_post(
    url     := base || '/' || fn,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 240000
  );
end;
$$;

revoke all on function jobscout.kick(text) from public, anon, authenticated;

-- Crawl at 06:10 and 18:10 America/New_York. pg_cron runs in UTC, so that is
-- 10:10 and 22:10 UTC during EDT. Scoring follows 20 minutes later, giving the
-- crawl time to finish and land its postings.
select cron.schedule('jobscout-ingest-am', '10 10 * * *', $$select jobscout.kick('jobscout-ingest')$$);
select cron.schedule('jobscout-ingest-pm', '10 22 * * *', $$select jobscout.kick('jobscout-ingest')$$);
select cron.schedule('jobscout-score-am',  '30 10 * * *', $$select jobscout.kick('jobscout-score')$$);
select cron.schedule('jobscout-score-pm',  '30 22 * * *', $$select jobscout.kick('jobscout-score')$$);

-- Discovery runs once a day and is a no-op once every company is resolved.
select cron.schedule('jobscout-discover', '0 8 * * *', $$select jobscout.kick('jobscout-discover')$$);

-- To stop everything:
--   select cron.unschedule('jobscout-ingest-am');  -- and the other four
