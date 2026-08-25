-- ============================================================
-- JobScout — the schedule. Replaces the unapplied 0002.
--
-- Applying this turns the machine ON: it starts crawling employer boards and
-- spending Anthropic tokens twice a day without anyone pressing a button.
--
-- WHY THIS REPLACES 0002
--
-- 0002 read the service-role key from a database setting that has to be
-- installed by hand:
--     alter database postgres set app.settings.jobscout_service_role_key = '...'
-- That is a secret nobody should be pasting anywhere, and it left the schedule
-- undeployable in practice — 0002 has sat unapplied since it was written.
--
-- The credential problem has a better answer. The edge functions already hold
-- service-role access to THIS database, so the database can mint a secret that
-- both sides can read and nobody else can. pg_cron sends it as a header; the
-- function compares it against the same row. No key leaves the project, and
-- nothing has to be typed into a dashboard.
--
-- It also closes a real hole. Every JobScout function is reachable with the
-- project's ANON key, which is public by design — so anyone holding it could
-- trigger a scoring run and spend real money. Requiring the token as well means
-- a valid JWT is no longer sufficient.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

-- ---- the shared secret -----------------------------------------------------

create table if not exists jobscout.runtime (
  id            boolean primary key default true check (id),
  functions_url text not null,
  -- Public by design; stored so kick() can build the Authorization header.
  anon_key      text not null,
  -- Minted here, read by the edge functions over their service-role
  -- connection, never displayed and never leaving the project.
  cron_token    text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at    timestamptz not null default now()
);

-- Nothing that reaches the API may read this table. service_role bypasses RLS,
-- which is exactly and only who should see it.
alter table jobscout.runtime enable row level security;
revoke all on jobscout.runtime from public;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on jobscout.runtime from %I', r);
    end if;
  end loop;
end $$;

-- ---- the kicker ------------------------------------------------------------

create or replace function jobscout.kick(fn text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg jobscout.runtime%rowtype;
begin
  select * into cfg from jobscout.runtime where id;
  if not found then
    -- Fail loudly. A schedule that silently does nothing is the worst outcome:
    -- it reads as "running" on every dashboard while nothing is crawled.
    raise exception 'jobscout.kick: jobscout.runtime is empty — nothing is configured';
  end if;

  return net.http_post(
    url     := cfg.functions_url || '/' || fn,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'Authorization',     'Bearer ' || cfg.anon_key,
                 'x-jobscout-token',  cfg.cron_token),
    body    := '{}'::jsonb,
    timeout_milliseconds := 240000
  );
end;
$$;

-- kick() is SECURITY DEFINER and reads the token, so nothing that reaches the
-- API may call it. Revoking from PUBLIC is what actually does the work;
-- anon/authenticated are revoked defensively but only if they exist, so this
-- file still applies on a plain Postgres.
revoke all on function jobscout.kick(text) from public;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function jobscout.kick(text) from %I', r);
    end if;
  end loop;
end $$;

-- ---- the schedule ----------------------------------------------------------
--
-- Crawl at 06:10 and 18:10 America/New_York. pg_cron runs in UTC, so that is
-- 10:10 and 22:10 during EDT. Scoring follows 25 minutes later: long enough for
-- a crawl that hits its wall-clock budget to have landed what it got, and the
-- postings it deferred are picked up by the next pair rather than lost.
--
-- Unscheduling first makes this file safe to re-run.
select cron.unschedule(jobname) from cron.job
 where jobname like 'jobscout-%';

select cron.schedule('jobscout-ingest-am', '10 10 * * *', $$select jobscout.kick('jobscout-ingest')$$);
select cron.schedule('jobscout-ingest-pm', '10 22 * * *', $$select jobscout.kick('jobscout-ingest')$$);
select cron.schedule('jobscout-score-am',  '35 10 * * *', $$select jobscout.kick('jobscout-score')$$);
select cron.schedule('jobscout-score-pm',  '35 22 * * *', $$select jobscout.kick('jobscout-score')$$);

-- Discovery is cheap and becomes a no-op once every company is resolved, but it
-- is what turns a newly-added employer into a crawled one, so it runs daily.
select cron.schedule('jobscout-discover', '0 8 * * *', $$select jobscout.kick('jobscout-discover')$$);

-- To stop everything:
--   select cron.unschedule(jobname) from cron.job where jobname like 'jobscout-%';
