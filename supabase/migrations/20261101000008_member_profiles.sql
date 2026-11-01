-- Per-colleague sender details: each member signs and sends as themselves.
-- Company-wide values in agent_settings remain the fallback.
create table if not exists public.member_profiles (
  tenant_id    uuid not null,
  user_id      uuid not null,
  sender_name  text check (length(sender_name) <= 120),
  signature    text check (length(signature) <= 600),
  from_email   text check (from_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references public.tenant_members(tenant_id, user_id) on delete cascade
);
alter table public.member_profiles enable row level security;
-- colleagues can see each other's sender details (who signs what); each edits only their own
create policy member_profiles_select on public.member_profiles for select to authenticated using (app.is_member(tenant_id));
create policy member_profiles_insert on public.member_profiles for insert to authenticated with check (user_id = auth.uid() and app.is_member(tenant_id));
create policy member_profiles_update on public.member_profiles for update to authenticated
  using (user_id = auth.uid() and app.is_member(tenant_id)) with check (user_id = auth.uid() and app.is_member(tenant_id));
grant select, insert, update on public.member_profiles to authenticated;
grant all on public.member_profiles to service_role;

-- Whose name and address a draft goes out under (the colleague whose mission or rewrite wrote it).
alter table public.message_drafts add column if not exists sender_user_id uuid references auth.users(id);
