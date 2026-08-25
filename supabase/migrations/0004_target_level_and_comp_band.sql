-- A floor and a goal are different numbers and were being conflated.
--
-- comp_floor is the walk-away: below it, the scorer caps a posting at 25.
-- The target band is what is actually being aimed at — a role beneath it is
-- disappointing, not disqualifying. Collapsing the two would have killed a
-- $92k Operations Director outright.
alter table jobscout.resumes
  add column if not exists comp_target_low  int,
  add column if not exists comp_target_high int,
  add column if not exists target_level     text;

comment on column jobscout.resumes.comp_floor is
  'Walk-away salary. A posting stating less is capped at 25 by the scorer.';
comment on column jobscout.resumes.comp_target_low is
  'Bottom of the band actually being aimed at. Below this is workable, not a no.';
comment on column jobscout.resumes.target_level is
  'Seniority being targeted. The scorer judges level by described scope, not title.';
