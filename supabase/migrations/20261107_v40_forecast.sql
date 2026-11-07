-- Dr Claude 4.0, second migration. Run this BEFORE deploying the functions: they read and write these
-- columns, and without them every analysis would lose its meals. Additive only.

-- 1. A figure nobody weighed stays a guess once it is on record. Rows already there stay as they are.
alter table public.mechabetics_meals add column if not exists carbs_estimated boolean not null default false;

-- 2. When the monitor last warned of a coming low: one warning an hour, however many runs agree.
alter table public.mechabetics_monitor_state add column if not exists low_warned_at timestamptz;

-- 3. Every forecast the monitor makes, kept to be compared with what really followed. One row per run
-- and per person, about 288 a day. `made_at` is the reading it was made from.
create table if not exists public.mechabetics_forecast_log (
  subject text not null,
  made_at timestamptz not null,
  value_mgdl integer not null,
  source text not null,
  f30 integer,
  low30 integer,
  high30 integer,
  f60 integer,
  low60 integer,
  high60 integer,
  lowest60 integer,
  low_risk60 real,
  low_warning boolean not null default false,
  warned boolean not null default false,
  model_fitted_at timestamptz,
  primary key (subject, made_at)
);
alter table public.mechabetics_forecast_log enable row level security;
revoke all on table public.mechabetics_forecast_log from anon, authenticated;

-- 4. Said, not assumed: the functions run as service_role, and a write it may not do fails with nothing
-- but a line in the logs. The same for the table of the first migration, which nothing has written yet.
grant select, insert, update on table public.mechabetics_forecast_log to service_role;
grant select, insert, update on table public.mechabetics_models to service_role;

-- What was done.
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'mechabetics_meals' and column_name = 'carbs_estimated') as meals_column,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'mechabetics_monitor_state' and column_name = 'low_warned_at') as state_column,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'mechabetics_forecast_log') as log_columns,
  (select relrowsecurity from pg_class where oid = 'public.mechabetics_forecast_log'::regclass) as log_rls,
  (select string_agg(distinct grantee, ',') from information_schema.role_table_grants where table_schema = 'public' and table_name = 'mechabetics_forecast_log') as log_grants,
  (select string_agg(distinct grantee, ',') from information_schema.role_table_grants where table_schema = 'public' and table_name = 'mechabetics_models') as models_grants;
