-- Dr Claude 4.0, fourth migration. Additive only, and nothing breaks without it: no pass, no domino, DeepSeek answers.

-- The keys of the Ubuntu's two model servers live in the Nueve project and never leave it. A function of this project
-- asks through a door over there (supabase/functions-nueve/mechabetics-domino), and the door has to know the ask comes
-- from here. No key is shared for that: a function writes a one-time pass here, and the door checks it here. Only this
-- project's own server can write one, and anyone can check one, because a pass nobody can guess proves nothing else.
create table if not exists public.mechabetics_domino_passes (
  pass uuid primary key,
  made_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.mechabetics_domino_passes enable row level security;
revoke all on public.mechabetics_domino_passes from anon, authenticated;
grant insert on public.mechabetics_domino_passes to service_role;

-- True once per pass, within two minutes of its making. What the door calls, with the public key.
create or replace function public.mechabetics_domino_pass(p_pass uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with taken as (
    update public.mechabetics_domino_passes
    set used_at = now()
    where pass = p_pass and used_at is null and made_at > now() - interval '2 minutes'
    returning 1
  )
  select exists (select 1 from taken);
$$;
revoke all on function public.mechabetics_domino_pass(uuid) from public;
grant execute on function public.mechabetics_domino_pass(uuid) to anon, service_role;
