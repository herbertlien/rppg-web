-- LINE 聊天室問卷：作答進度與選單對照。只有後端函式（service_role）能讀寫。
create table if not exists public.quiz_sessions (
  user_id uuid primary key references public.users(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  cur text,
  multi jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.rich_menus (
  question_id text primary key,
  rich_menu_id text not null,
  questions_version text not null,
  created_at timestamptz not null default now()
);

alter table public.quiz_sessions enable row level security;
alter table public.rich_menus enable row level security;
revoke all on public.quiz_sessions, public.rich_menus from anon, authenticated;

-- 後端函式（service_role）要有讀寫權限；Supabase 對手動建立的資料表不一定自動授權
grant all on public.quiz_sessions, public.rich_menus to service_role;
