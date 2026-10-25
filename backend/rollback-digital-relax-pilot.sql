-- TEST DATABASE ONLY. Disable the pilot and restore the previous test function first.
-- Destructive to pilot answers/consent/interest only. Never use CASCADE.
begin;
drop table if exists public.digital_relax_pilot_sessions;
commit;
