-- Deerly 掃描結果資料表（最小版）。只存摘要，不存影像與逐幀顏色。
create table public.users (
  id uuid primary key default gen_random_uuid(),
  line_sub text not null unique,
  created_at timestamptz not null default now()
);

create table public.consents (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  version text not null,
  consented_at timestamptz not null default now()
);

create table public.scans (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  scanned_at timestamptz not null default now(),
  bpm numeric(5,1) not null check (bpm between 30 and 220),
  quality numeric(4,3) not null check (quality between 0 and 1),
  valid_frames int,
  algo_version text not null,
  device text
);

create index scans_user_time on public.scans (user_id, scanned_at desc);

-- 預設全部鎖死：前端不能直接讀寫，只有後端函式（service_role）能存取
alter table public.users enable row level security;
alter table public.consents enable row level security;
alter table public.scans enable row level security;

revoke all on public.users, public.consents, public.scans from anon, authenticated;
grant all on public.users, public.consents, public.scans to service_role;
grant usage, select on all sequences in schema public to service_role;
