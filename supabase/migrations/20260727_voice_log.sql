-- Voice Q&A history (History › Voix).
--
-- Spoken questions were never persisted: only the coach's ANALYSE was written to
-- mechabetics_coach_log, so a voice answer vanished the moment it finished being read aloud. These
-- two nullable columns let the same table carry both kinds without a second table:
--
--   kind     'analysis' (the ANALYSE report) | 'voice' (a spoken Q&A). NULL = legacy row = analysis.
--   question the transcribed question, for voice rows only.
--
-- Additive and safe to re-run: existing rows keep working (kind NULL reads as 'analysis'), and the
-- edge functions tolerate the columns being absent, so applying this is not urgent — until it runs,
-- the Voix tab simply stays empty.
--
-- Apply from the Supabase dashboard → SQL Editor, or `supabase db push` once the project is linked.

alter table public.mechabetics_coach_log
  add column if not exists kind text,
  add column if not exists question text;

-- Existing rows are all coach analyses.
update public.mechabetics_coach_log set kind = 'analysis' where kind is null;

alter table public.mechabetics_coach_log
  alter column kind set default 'analysis';

-- The history endpoint filters by subject + kind, newest first.
create index if not exists mechabetics_coach_log_subject_kind_ts_idx
  on public.mechabetics_coach_log (subject, kind, ts desc);
