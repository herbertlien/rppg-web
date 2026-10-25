-- Additive TEST-ONLY migration. No changes to original supplement tables or LINE menus.
begin;
alter table public.digital_relax_pilot_sessions
  add column if not exists current_rich_menu_id text,
  add column if not exists previous_rich_menu_id text,
  add column if not exists rich_menu_captured boolean not null default false;
commit;
