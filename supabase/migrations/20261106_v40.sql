-- Dr Claude v4.0. Run this BEFORE deploying the functions: they read these columns.
-- Additive only. Nothing is deleted: mixed rows are flagged, and stay in the table.

-- 1. Where each reading comes from, and which ones are not to be trusted.
alter table public.mechabetics_readings
  add column if not exists source text,
  add column if not exists suspect boolean not null default false;

-- 2. What the decision has to remember between two analyses.
alter table public.mechabetics_profiles
  add column if not exists no_insulin_confirmed_at timestamptz,
  add column if not exists pending_action jsonb,
  add column if not exists basal_changed_at timestamptz,
  add column if not exists tz_offset_min integer;

alter table public.mechabetics_coach_log add column if not exists decision jsonb;
alter table public.mechabetics_voice_log add column if not exists action text;

-- 3. What the app learns from each person's history. Service role only.
create table if not exists public.mechabetics_models (
  subject text primary key,
  model jsonb not null,
  fitted_at timestamptz not null default now()
);
alter table public.mechabetics_models enable row level security;
revoke all on table public.mechabetics_models from anon, authenticated;

-- 4. Five-minute series for the learner, as ONE value: PostgREST caps a response at 1000 rows and four
-- months of buckets is about 34 000.
create or replace function public.mechabetics_series5(p_subject text, p_since timestamptz)
returns jsonb language sql security definer set search_path to 'public' as $fn$
  select coalesce(jsonb_agg(jsonb_build_array(b, v) order by b), '[]'::jsonb)
  from (
    select (floor(extract(epoch from ts) / 300) * 300)::bigint as b, round(avg(value_mgdl))::int as v
    from public.mechabetics_readings
    where subject = p_subject and ts >= p_since and not suspect and value_mgdl > 0
    group by 1
  ) q;
$fn$;
-- A new SECURITY DEFINER function is executable by PUBLIC until told otherwise.
revoke all on function public.mechabetics_series5(text, timestamptz) from public, anon, authenticated;
grant execute on function public.mechabetics_series5(text, timestamptz) to service_role;

-- 5. Stats and GMI stop counting suspect rows. CREATE OR REPLACE keeps the existing grants.
do $$
declare d text;
begin
  select pg_get_functiondef('public.mechabetics_stats(text,integer)'::regprocedure) into d;
  if position('NOT suspect' in d) = 0 then
    d := replace(d, 'FROM public.mechabetics_readings WHERE subject = p_subject',
                    'FROM public.mechabetics_readings WHERE subject = p_subject AND NOT suspect');
    execute d;
  end if;
  select pg_get_functiondef('public.mechabetics_gmi(text,integer)'::regprocedure) into d;
  if position('not suspect' in d) = 0 then
    d := replace(d, 'where subject = p_subject', 'where subject = p_subject and not suspect');
    execute d;
  end if;
end $$;

-- 6. Two bodies mixed in one record. The same instant and the same value in two people's records
-- cannot be two measurements: 845 such pairs on nine dates (07-09, 07-11, 07-23, 07-25, 08-01, 09-14,
-- 09-17, 10-18, 10-19). Which of the two is the copy cannot be told from the row, so both are flagged.
update public.mechabetics_readings a
set suspect = true
from public.mechabetics_readings b
where a.subject <> b.subject and a.ts = b.ts and a.value_mgdl = b.value_mgdl and not a.suspect;

-- ...and on those same dates, what is left that stands 30 mg/dL off the median of the five minutes
-- around it: the rest of the interleaving (138 / 67 / 138 / 67), which landed on nearby timestamps.
with days(d) as (
  values ('2026-07-09'::date), ('2026-07-11'), ('2026-07-23'), ('2026-07-25'), ('2026-08-01'),
         ('2026-09-14'), ('2026-09-17'), ('2026-10-18'), ('2026-10-19')
), near as (
  select a.subject, a.ts, a.value_mgdl, m.med, m.n
  from public.mechabetics_readings a
  cross join lateral (
    select percentile_cont(0.5) within group (order by b.value_mgdl) as med, count(*) as n
    from public.mechabetics_readings b
    where b.subject = a.subject and not b.suspect
      and b.ts between a.ts - interval '5 minutes' and a.ts + interval '5 minutes'
  ) m
  where not a.suspect and a.ts::date in (select d from days)
)
update public.mechabetics_readings r
set suspect = true
from near
where r.subject = near.subject and r.ts = near.ts and near.n >= 5 and abs(near.value_mgdl - near.med) >= 30;

-- 7. Consignes stored in the base that contradicted the code. The database wins over the code's
-- fallback text, which is how "donne la dose" and "un pic à corriger" kept reaching the model.
update public.mechabetics_prompts set content = replace(content,
  ': compte les glucides et donne la dose pour les couvrir.',
  ': estime les glucides dans "meal", le système calcule la dose. N''écris jamais de chiffre de dose.')
where name = 'ask.sugar' and lang = 'fr';
update public.mechabetics_prompts set content = replace(content,
  ': cuenta los carbohidratos y da la dosis para cubrirlos.',
  ': estima los carbohidratos en "meal", el sistema calcula la dosis. Nunca escribas una cifra de dosis.')
where name = 'ask.sugar' and lang = 'es';
update public.mechabetics_prompts set content = replace(content,
  ': compte les glucides et donne la dose.',
  ': estime les glucides dans "meal", le système calcule la dose. N''écris jamais de chiffre de dose.')
where name = 'scan.sugar' and lang = 'fr';
update public.mechabetics_prompts set content = replace(content,
  ': cuenta los carbohidratos y da la dosis.',
  ': estima los carbohidratos en "meal", el sistema calcula la dosis. Nunca escribas una cifra de dosis.')
where name = 'scan.sugar' and lang = 'es';
update public.mechabetics_prompts set content = replace(replace(content,
  'le point le plus haut du jour est un pic à corriger, pas un plafond acceptable.',
  'le point le plus haut du jour n''est pas un plafond acceptable : dis-le comme un pic OBSERVÉ, à éviter les prochains jours, pas comme une consigne pour maintenant.'),
  'Souligne les progrès.', 'Souligne les progrès RÉELS, sans jamais taire une hypo.')
where name = 'coach.rules' and lang = 'fr';
update public.mechabetics_prompts set content = replace(replace(content,
  'lo más alto del día es un pico a corregir, no un techo aceptable.',
  'lo más alto del día no es un techo aceptable: dilo como un pico OBSERVADO, a evitar los próximos días, no como una consigna para ahora.'),
  'Resalta los progresos.', 'Resalta los progresos REALES, sin callar nunca una hipo.')
where name = 'coach.rules' and lang = 'es';

-- What was done.
select
  (select count(*) from public.mechabetics_readings where suspect) as suspect_rows,
  (select count(distinct subject) from public.mechabetics_readings where suspect) as subjects,
  (select count(*) from public.mechabetics_prompts where content like '%donne la dose%' or content like '%da la dosis%' or content like '%pic à corriger%' or content like '%pico a corregir%') as prompts_still_wrong,
  (select string_agg(grantee, ',') from information_schema.routine_privileges where routine_name = 'mechabetics_series5') as series_grants,
  (select string_agg(grantee, ',') from information_schema.routine_privileges where routine_name = 'mechabetics_stats') as stats_grants;
