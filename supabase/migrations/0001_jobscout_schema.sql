-- ============================================================
-- JobScout — direct-from-employer job search engine
-- Schema: jobscout   (Herman Legacy Business Platform / Supabase)
-- Run this once in the Supabase SQL editor.
-- ============================================================

-- trigram extension: must exist before the gin_trgm_ops index below
create extension if not exists pg_trgm;

create schema if not exists jobscout;

-- ---------- employers we care about ----------
create table if not exists jobscout.companies (
  id            bigserial primary key,
  name          text not null,
  careers_url   text,
  ats           text,                 -- greenhouse | lever | ashby | smartrecruiters | workday | icims | paylocity | adp | unknown | manual
  board_token   text,                 -- ATS-specific board identifier (see discover.py)
  workday_host  text,                 -- e.g. wd1.myworkdayjobs.com
  workday_site  text,                 -- e.g. External
  city          text,
  state         text default 'NY',
  size_band     text,                 -- micro | small | mid | large
  owner_type    text,                 -- private | family | public | pe | nonprofit | gov
  priority      int  default 3,       -- 1 = chase hardest
  active        boolean default true,
  notes         text,
  website       text,                 -- what discover.ts starts from
  -- Crawl/discovery bookkeeping. Ordering by these is how a scheduled run
  -- rotates through the whole list without a cursor it could lose.
  last_crawled_at        timestamptz,
  discover_attempted_at  timestamptz,
  discover_evidence      text,
  created_at    timestamptz default now(),
  unique (name)
);

create index if not exists companies_ats_idx on jobscout.companies (ats) where active;

-- ---------- raw postings ----------
create table if not exists jobscout.jobs (
  id            bigserial primary key,
  company_id    bigint not null references jobscout.companies(id) on delete cascade,
  ats_job_id    text not null,
  title         text not null,
  location      text,
  department    text,
  url           text,
  description   text,
  comp_text     text,                 -- any salary string we can scrape
  posted_at     timestamptz,
  first_seen    timestamptz default now(),
  last_seen     timestamptz default now(),
  is_open       boolean default true,
  unique (company_id, ats_job_id)
);

create index if not exists jobs_open_idx on jobscout.jobs (is_open, last_seen desc);
create index if not exists jobs_title_trgm on jobscout.jobs using gin (title extensions.gin_trgm_ops);

-- ---------- the resume(s) we match against ----------
create table if not exists jobscout.resumes (
  id            bigserial primary key,
  label         text not null,
  content       text not null,        -- plain text resume
  must_have     text[],               -- hard requirements, e.g. {'Western New York'}
  dealbreakers  text[],               -- e.g. {'requires PE license','50% travel'}
  comp_floor    int,                  -- annual USD
  created_at    timestamptz default now(),
  unique (label)
);

-- ---------- scored matches ----------
create table if not exists jobscout.scores (
  id            bigserial primary key,
  job_id        bigint not null references jobscout.jobs(id) on delete cascade,
  resume_id     bigint not null references jobscout.resumes(id) on delete cascade,
  fit_score     int,                  -- 0-100
  verdict       text,                 -- apply | maybe | pass
  why_fits      text,
  why_not       text,
  resume_angle  text,                 -- how to pitch himself for THIS role
  model         text,
  scored_at     timestamptz default now(),
  unique (job_id, resume_id)
);

create index if not exists scores_rank_idx on jobscout.scores (resume_id, fit_score desc);

-- ---------- application tracking (so this replaces the spreadsheet too) ----------
create table if not exists jobscout.applications (
  id            bigserial primary key,
  job_id        bigint not null references jobscout.jobs(id) on delete cascade,
  status        text default 'shortlisted',  -- shortlisted | applied | screening | interview | offer | rejected | withdrawn
  applied_at    timestamptz,
  contact_name  text,
  contact_email text,
  notes         text,
  updated_at    timestamptz default now(),
  unique (job_id)
);

-- ---------- the view the dashboard reads ----------
create or replace view jobscout.v_shortlist as
select
  s.fit_score,
  s.verdict,
  s.why_fits,
  s.why_not,
  s.resume_angle,
  j.id           as job_id,
  j.title,
  j.location,
  j.url,
  j.comp_text,
  j.posted_at,
  j.first_seen,
  c.name         as company,
  c.city,
  c.owner_type,
  c.size_band,
  coalesce(a.status, 'new') as status
from jobscout.scores s
join jobscout.jobs j       on j.id = s.job_id
join jobscout.companies c  on c.id = j.company_id
left join jobscout.applications a on a.job_id = j.id
where j.is_open
order by s.fit_score desc, j.first_seen desc;


-- ---------- what each scheduled run actually did ----------
-- Principle 10: the dashboard never invents a successful run. If a panel is
-- empty it is because this table says nothing ran, and it says why.
create table if not exists jobscout.runs (
  id          bigserial primary key,
  kind        text not null,          -- ingest | score | discover
  ok          boolean not null,
  report      jsonb not null,
  ran_at      timestamptz default now()
);

create index if not exists runs_recent_idx on jobscout.runs (kind, ran_at desc);

-- The last run of each kind, for the dashboard's status line.
create or replace view jobscout.v_last_runs as
select distinct on (kind) kind, ok, report, ran_at
from jobscout.runs
order by kind, ran_at desc;
