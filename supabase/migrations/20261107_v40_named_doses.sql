-- Dr Claude 4.0, third migration. Additive only, and nothing breaks without it: doses are still named and
-- remembered, the score is simply not updated and the second look has nothing to come back to.

-- 1. What the app named, on every surface, at the hour it falls due, so that the doses that follow can be
-- told from the others.
create table if not exists public.mechabetics_named_doses (
  subject text not null,
  named_at timestamptz not null default now(),
  units real not null,
  primary key (subject, named_at)
);
alter table public.mechabetics_named_doses enable row level security;
revoke all on public.mechabetics_named_doses from anon, authenticated;
grant select, insert on public.mechabetics_named_doses to service_role;

-- 2. What the floor kept back from a meal's dose: the one thing the second look is allowed to come back to.
alter table public.mechabetics_profiles add column if not exists held_back jsonb;
