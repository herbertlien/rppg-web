-- Separate from supplement quiz_sessions/intakes/packs. Apply manually only in a TEST environment.
begin;
create table if not exists public.digital_relax_pilot_sessions (
  user_id uuid primary key references public.users(id) on delete cascade,
  flow_id uuid not null default gen_random_uuid(),
  revision integer not null default 0 check (revision >= 0),
  paused boolean not null default false,
  answers jsonb not null default '{}'::jsonb,
  step integer not null default 0 check (step between 0 and 5),
  status text not null default 'quiz' check (status in ('quiz','scan','preview')),
  scan_opt_in boolean not null default false,
  scan_started_at timestamptz,
  consent_version text not null default 'relax-pilot-2026-10',
  interest_clicked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.digital_relax_pilot_sessions enable row level security;
revoke all on public.digital_relax_pilot_sessions from anon, authenticated;
grant all on public.digital_relax_pilot_sessions to service_role;
-- Retention/expiry policy required before public launch; test records can be deleted
-- individually with the chatbot command 「刪除放鬆測試資料」.

-- Additive upgrade for an existing TEST pilot table. Never execute against production.
alter table public.digital_relax_pilot_sessions
  add column if not exists flow_id uuid not null default gen_random_uuid(),
  add column if not exists revision integer not null default 0 check (revision >= 0),
  add column if not exists paused boolean not null default false;

commit;
