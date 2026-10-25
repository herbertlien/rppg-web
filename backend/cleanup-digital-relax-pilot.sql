-- TEST DATABASE ONLY. Run daily while the pilot is enabled; no production execution authorized.
-- Fixed retention from consent, not from last answer. Does not delete users or original scans.
begin;
delete from public.digital_relax_pilot_sessions
where created_at <= now() - interval '30 days';
commit;
