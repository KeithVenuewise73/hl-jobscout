-- ============================================================
-- JobScout — tailored resumes and cover letters.
--
-- NOT YET APPLIED. Applying it is a decision, per the standing rule.
--
-- One row per (job, resume). Re-tailoring the same job overwrites it: there is
-- no value in keeping five drafts of the same application, and a table that
-- grows a row per click becomes a thing to prune.
--
-- WHY THE VERIFICATION RESULT IS STORED, NOT JUST THE DOCUMENT
--
-- The model is allowed to reorder, reword and omit. It is not allowed to add,
-- and _shared/tailor.ts checks that mechanically: every bullet must quote the
-- resume line it came from, and every number must already appear in the
-- resume. `report` is what that check found and `verified` is whether the
-- document came through clean.
--
-- Keeping it means a resume he sent six weeks ago can still be asked "was
-- anything in this unverifiable?". Storing the document alone would leave him
-- trusting a check he cannot re-examine — which is the same as no check.
-- ============================================================

create table if not exists jobscout.tailorings (
  id            bigserial primary key,
  job_id        bigint not null references jobscout.jobs(id) on delete cascade,
  resume_id     bigint not null references jobscout.resumes(id) on delete cascade,
  headline      text,
  bullets       jsonb,                -- [{text, source, section}] — source is the receipt
  skills        jsonb,
  cover_letter  text,
  omitted       text,                 -- what he does NOT have. For his eyes only.
  resume_text   text,                 -- the rendered, ATS-parseable document
  verified      boolean not null default false,
  report        jsonb,                -- what verification found, including anything dropped
  model         text,
  created_at    timestamptz default now(),
  unique (job_id, resume_id)
);

create index if not exists tailorings_job_idx on jobscout.tailorings (job_id);
