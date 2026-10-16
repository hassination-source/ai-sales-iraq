-- Email sending: delivery fields on drafts, a per-tenant suppression list, sender address.

alter table public.message_drafts
  add column if not exists to_email            text,
  add column if not exists sent_at             timestamptz,
  add column if not exists provider_message_id text,
  add column if not exists send_error          text;

alter table public.agent_settings
  add column if not exists from_email text check (from_email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$');

-- Addresses that asked not to be contacted (or bounced / complained). Checked before every send.
create table if not exists public.email_suppressions (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  email      text not null check (email = lower(email)),
  reason     text not null check (reason in ('unsubscribed','bounced','complained','manual')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, email)
);
alter table public.email_suppressions enable row level security;
create policy email_suppressions_select on public.email_suppressions for select to authenticated using (app.is_member(tenant_id));
create policy email_suppressions_insert on public.email_suppressions for insert to authenticated with check (app.is_member(tenant_id));
grant select, insert on public.email_suppressions to authenticated;
grant all on public.email_suppressions to service_role;

-- Delivery fields are written by the sending worker (service role) only.
-- Named to fire after message_drafts_guard (triggers run alphabetically), so transition errors keep their message.
create or replace function app.guard_draft_delivery()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and (
       new.to_email is distinct from old.to_email
    or new.sent_at is distinct from old.sent_at
    or new.provider_message_id is distinct from old.provider_message_id
    or new.send_error is distinct from old.send_error
    or (new.status in ('sent','failed') and new.status is distinct from old.status)) then
    raise exception 'delivery fields are set by the sending service only' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists message_drafts_zdelivery_guard on public.message_drafts;
create trigger message_drafts_zdelivery_guard before update on public.message_drafts
  for each row execute function app.guard_draft_delivery();
