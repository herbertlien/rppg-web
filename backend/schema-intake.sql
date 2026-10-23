-- Deerly 問卷與待審配方（步驟 3）。在 Supabase 的 SQL Editor 執行一次即可。
-- 跟掃描資料表一樣全部鎖死，只有後端函式（service_role）能讀寫；刪除使用者時一併刪除。

create table public.intakes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  questions_version text not null,
  answers jsonb not null
);

create table public.packs (
  id bigint generated always as identity primary key,
  intake_id bigint not null references public.intakes(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  engine_version text not null,
  data_version jsonb not null,
  result jsonb not null,                -- 引擎完整輸出（不接單的情況不保存）
  item_ids text[] not null default '{}', -- 最後的品項（審核時可手動調整）
  status text not null check (status in ('needs_review', 'approved', 'returned')),
  reviewed_at timestamptz,
  review_note text
);

create index intakes_user_time on public.intakes (user_id, created_at desc);
create index packs_user_time on public.packs (user_id, created_at desc);
create index packs_status on public.packs (status, created_at);

alter table public.intakes enable row level security;
alter table public.packs enable row level security;

revoke all on public.intakes, public.packs from anon, authenticated;
grant all on public.intakes, public.packs to service_role;
grant usage, select on all sequences in schema public to service_role;
