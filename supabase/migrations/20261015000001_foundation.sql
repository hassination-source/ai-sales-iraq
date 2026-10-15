-- =====================================================================
-- AI Sales Platform Iraq — Phase 1 foundation
-- Multi-tenancy, roles, industry configuration, CRM core, drafts,
-- activity/usage events and audit log. Every tenant-owned table:
--   * carries tenant_id
--   * has row-level security enabled
--   * links to other tenant rows through composite (tenant_id, id) FKs,
--     so a row can never point at another tenant's data, even via a bug
--     in application code.
-- =====================================================================

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.member_role as enum ('owner', 'admin', 'manager', 'salesperson');
create type public.tenant_status as enum ('trial', 'active', 'suspended', 'closed');
create type public.verification_status as enum ('unverified', 'verified', 'invalid');
create type public.stage_kind as enum ('open', 'won', 'lost');
create type public.task_status as enum ('open', 'done', 'cancelled');
create type public.draft_status as enum ('pending_review', 'approved', 'rejected', 'sent', 'failed');
create type public.channel as enum ('whatsapp', 'email', 'sms', 'phone', 'in_person', 'other');
create type public.consent_basis as enum ('unknown', 'opt_in', 'existing_customer', 'inbound_inquiry', 'legitimate_interest_pending_legal_review');

-- ---------------------------------------------------------------------
-- Tenants and membership
-- ---------------------------------------------------------------------
create table public.tenants (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 2 and 200),
  slug              text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status            public.tenant_status not null default 'trial',
  plan              text not null default 'trial',
  trial_ends_at     timestamptz,
  default_currency  char(3) not null default 'USD' check (default_currency ~ '^[A-Z]{3}$'),
  -- Independent language settings (dashboard / AI content / customer comms / reports)
  locale_settings   jsonb not null default '{"dashboard":"ar","aiContent":"ar-IQ","communications":"ar-IQ","reports":"ar"}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.member_role not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members(user_id);

-- Platform operators (separate admin area). Not tenant-scoped.
create table public.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER so RLS on tenant_members does
-- not recurse). search_path pinned to avoid hijacking.
-- ---------------------------------------------------------------------
create or replace function app.current_role_in(p_tenant uuid)
returns public.member_role
language sql stable security definer set search_path = public, pg_temp
as $$
  select role from public.tenant_members
  where tenant_id = p_tenant and user_id = auth.uid()
$$;

create or replace function app.is_member(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.tenant_members
                 where tenant_id = p_tenant and user_id = auth.uid())
$$;

create or replace function app.has_role(p_tenant uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.current_role_in(p_tenant) = any(p_roles), false)
$$;

create or replace function app.is_platform_admin()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- tenant_id may never change after insert (blocks moving rows between tenants)
create or replace function app.forbid_tenant_change()
returns trigger language plpgsql as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Industry configuration (one active pack per tenant + tenant overrides).
-- Pack definitions live in code (packages/core/src/packs) and are
-- validated there; the DB stores which pack/version and the overrides.
-- ---------------------------------------------------------------------
create table public.industry_configs (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  pack_id       text not null check (pack_id ~ '^[a-z0-9-]+$'),
  pack_version  integer not null check (pack_version > 0),
  overrides     jsonb not null default '{}',
  updated_by    uuid references auth.users(id),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Pipelines and stages (configurable per tenant)
-- ---------------------------------------------------------------------
create table public.pipelines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index pipelines_one_default on public.pipelines(tenant_id) where is_default;

create table public.pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  pipeline_id  uuid not null,
  key          text not null check (key ~ '^[a-z0-9_]+$'),
  label        jsonb not null,             -- {"ar": "...", "en": "..."}
  position     integer not null,
  kind         public.stage_kind not null default 'open',
  probability  numeric(5,2) check (probability between 0 and 100),
  unique (tenant_id, id),
  unique (pipeline_id, key),
  foreign key (tenant_id, pipeline_id) references public.pipelines(tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Companies (leads / accounts). Provenance is mandatory for anything
-- not entered by hand: source_type + source_url + discovered_at.
-- ---------------------------------------------------------------------
create table public.companies (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  name                 text not null check (length(trim(name)) > 0),
  name_normalized      text not null,
  industry             text,
  subindustry          text,
  governorate          text,     -- ISO 3166-2:IQ code, e.g. IQ-BG
  city                 text,
  district             text,
  territory            text,
  website              text,
  phone                text,
  email                text,
  description          text,
  attributes           jsonb not null default '{}',   -- pack-specific fields
  verification_status  public.verification_status not null default 'unverified',
  confidence           numeric(4,3) check (confidence between 0 and 1),
  source_type          text not null default 'manual' check (source_type in ('manual','csv_import','xlsx_import','web','api','test_fixture')),
  source_url           text,
  source_ref           text,
  discovered_at        timestamptz not null default now(),
  last_verified_at     timestamptz,
  fit_score            numeric(5,2),
  owner_id             uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  check (verification_status <> 'verified' or last_verified_at is not null),
  check (source_type not in ('web','api') or source_url is not null)
);
create index companies_dedupe_idx on public.companies(tenant_id, name_normalized, coalesce(governorate, ''));
create index companies_geo_idx on public.companies(tenant_id, governorate, city);

create table public.contacts (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  company_id           uuid,
  full_name            text,
  job_title            text,
  phone                text,      -- E.164
  whatsapp             text,      -- E.164
  email                text,
  preferred_language   text,
  verification_status  public.verification_status not null default 'unverified',
  source_url           text,
  consent_basis        public.consent_basis not null default 'unknown',
  consent_recorded_at  timestamptz,
  opted_out_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references public.companies(tenant_id, id) on delete set null (company_id)
);
create index contacts_company_idx on public.contacts(tenant_id, company_id);

-- ---------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------
create table public.deals (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  company_id            uuid not null,
  primary_contact_id    uuid,
  pipeline_id           uuid not null,
  stage_id              uuid not null,
  title                 text not null,
  value_amount          numeric(18,2) check (value_amount >= 0),
  currency              char(3) check (currency ~ '^[A-Z]{3}$'),
  qualification         jsonb not null default '{}',   -- pack-defined fields
  owner_id              uuid references auth.users(id),
  expected_close_date   date,
  lost_reason           text,
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, id),
  check (value_amount is null or currency is not null),
  foreign key (tenant_id, company_id)         references public.companies(tenant_id, id) on delete cascade,
  foreign key (tenant_id, primary_contact_id) references public.contacts(tenant_id, id) on delete set null (primary_contact_id),
  foreign key (tenant_id, pipeline_id)        references public.pipelines(tenant_id, id),
  foreign key (tenant_id, stage_id)           references public.pipeline_stages(tenant_id, id)
);
create index deals_stage_idx on public.deals(tenant_id, stage_id);

-- ---------------------------------------------------------------------
-- Tasks / reminders
-- ---------------------------------------------------------------------
create table public.tasks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  deal_id         uuid,
  company_id      uuid,
  assignee_id     uuid references auth.users(id),
  title           text not null,
  notes           text,
  due_at          timestamptz,
  status          public.task_status not null default 'open',
  created_by_ai   boolean not null default false,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, deal_id)    references public.deals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, company_id) references public.companies(tenant_id, id) on delete cascade
);
create index tasks_due_idx on public.tasks(tenant_id, status, due_at);

-- ---------------------------------------------------------------------
-- AI-generated message drafts (human-in-the-loop)
-- ---------------------------------------------------------------------
create table public.message_drafts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  deal_id        uuid,
  company_id     uuid,
  contact_id     uuid,
  channel        public.channel not null,
  language       text not null,
  subject        text,
  body           text not null,
  -- What the draft is grounded in: knowledge-base docs, company facts,
  -- and which statements are hypotheses. Required for AI drafts.
  grounding      jsonb not null default '{"sources":[],"hypotheses":[]}',
  status         public.draft_status not null default 'pending_review',
  generated_by   text not null default 'human',      -- 'human' or model id
  edited         boolean not null default false,
  reviewed_by    uuid references auth.users(id),
  reviewed_at    timestamptz,
  reject_reason  text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, deal_id)    references public.deals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, company_id) references public.companies(tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references public.contacts(tenant_id, id) on delete set null (contact_id)
);

-- ---------------------------------------------------------------------
-- Activities: the event stream every metric is computed from.
-- ---------------------------------------------------------------------
create table public.activities (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  type         text not null check (type ~ '^[a-z_.]+$'),  -- e.g. lead.created, deal.stage_changed, message.sent
  deal_id      uuid,
  company_id   uuid,
  contact_id   uuid,
  actor_id     uuid,
  payload      jsonb not null default '{}',
  occurred_at  timestamptz not null default now()
);
create index activities_type_time_idx on public.activities(tenant_id, type, occurred_at);

-- AI and messaging cost/usage events (spend limits, billing, ROI)
create table public.usage_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  kind         text not null,               -- ai.tokens, message.whatsapp, research.job ...
  quantity     numeric(18,4) not null default 1,
  cost_usd     numeric(18,6) not null default 0,
  metadata     jsonb not null default '{}',
  occurred_at  timestamptz not null default now()
);
create index usage_events_idx on public.usage_events(tenant_id, kind, occurred_at);

-- ---------------------------------------------------------------------
-- Audit log — append-only; written by triggers (SECURITY DEFINER).
-- ---------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  tenant_id    uuid references public.tenants(id) on delete cascade,
  actor_id     uuid,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  at           timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log(tenant_id, at desc);

create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_log(tenant_id, actor_id, action, entity_type, entity_id, before, after)
  values (
    (v_row->>'tenant_id')::uuid,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'user_id', v_row->>'tenant_id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------
-- Business-rule triggers
-- ---------------------------------------------------------------------

-- Only owners may grant/hold 'owner'; admins cannot escalate; a tenant
-- must always keep at least one owner.
create or replace function app.guard_membership()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor public.member_role;
begin
  if auth.uid() is null then return coalesce(new, old); end if;  -- service role / migrations
  v_actor := app.current_role_in(coalesce(new.tenant_id, old.tenant_id));
  -- bootstrap: the creator becomes the first owner of an empty tenant
  if tg_op = 'INSERT' and new.role = 'owner' and new.user_id = auth.uid()
     and not exists (select 1 from public.tenant_members where tenant_id = new.tenant_id) then
    return new;
  end if;
  if (tg_op in ('INSERT','UPDATE') and new.role = 'owner' and v_actor is distinct from 'owner')
     or (tg_op in ('UPDATE','DELETE') and old.role = 'owner' and v_actor is distinct from 'owner') then
    raise exception 'only an owner can grant, change or remove the owner role' using errcode = '42501';
  end if;
  if tg_op in ('UPDATE','DELETE') and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and (select count(*) from public.tenant_members where tenant_id = old.tenant_id and role = 'owner') <= 1 then
    raise exception 'a tenant must keep at least one owner' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;

-- Draft review: only owner/admin/manager can approve or reject; AI drafts
-- must carry grounding; sent/failed only from approved.
create or replace function app.guard_draft()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending_review' then
      raise exception 'drafts must start in pending_review' using errcode = '23514';
    end if;
    if new.generated_by <> 'human' and jsonb_typeof(new.grounding->'sources') is distinct from 'array' then
      raise exception 'AI drafts must record grounding sources' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.body is distinct from old.body or new.subject is distinct from old.subject then
    if old.status not in ('pending_review') then
      raise exception 'only drafts pending review can be edited' using errcode = '23514';
    end if;
    new.edited := true;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved','rejected') then
      if old.status <> 'pending_review' then
        raise exception 'invalid draft transition % -> %', old.status, new.status using errcode = '23514';
      end if;
      if auth.uid() is not null and not app.has_role(new.tenant_id, array['owner','admin','manager']::public.member_role[]) then
        raise exception 'only managers or above can approve or reject drafts' using errcode = '42501';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    elsif new.status in ('sent','failed') then
      if old.status <> 'approved' then
        raise exception 'only approved drafts can be sent' using errcode = '23514';
      end if;
    elsif new.status = 'pending_review' then
      raise exception 'cannot move a draft back to pending_review' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- Record stage changes as activities (source of pipeline metrics)
create or replace function app.deal_stage_activity()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_kind public.stage_kind;
begin
  if tg_op = 'INSERT' then
    insert into public.activities(tenant_id, type, deal_id, company_id, actor_id, payload)
    values (new.tenant_id, 'deal.created', new.id, new.company_id, auth.uid(), jsonb_build_object('stage_id', new.stage_id));
  elsif new.stage_id is distinct from old.stage_id then
    select kind into v_kind from public.pipeline_stages where id = new.stage_id;
    if v_kind in ('won','lost') and new.closed_at is null then new.closed_at := now(); end if;
    if v_kind = 'lost' and coalesce(trim(new.lost_reason), '') = '' then
      raise exception 'a lost reason is required' using errcode = '23514';
    end if;
    insert into public.activities(tenant_id, type, deal_id, company_id, actor_id, payload)
    values (new.tenant_id, 'deal.stage_changed', new.id, new.company_id, auth.uid(),
            jsonb_build_object('from', old.stage_id, 'to', new.stage_id, 'kind', v_kind));
  end if;
  return new;
end $$;

-- Wire triggers
do $$
declare t text;
begin
  foreach t in array array['companies','contacts','deals','tasks','message_drafts','pipelines','pipeline_stages','industry_configs','tenant_members','activities','usage_events']
  loop
    execute format('create trigger %I_tenant_immutable before update on public.%I for each row execute function app.forbid_tenant_change()', t, t);
  end loop;
  foreach t in array array['tenants','companies','contacts','deals','tasks','message_drafts']
  loop
    execute format('create trigger %I_touch before update on public.%I for each row execute function app.touch_updated_at()', t, t);
  end loop;
  foreach t in array array['tenant_members','industry_configs','deals','message_drafts','contacts','pipeline_stages']
  loop
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function app.audit()', t, t);
  end loop;
end $$;

create trigger tenant_members_guard before insert or update or delete on public.tenant_members
  for each row execute function app.guard_membership();
create trigger message_drafts_guard before insert or update on public.message_drafts
  for each row execute function app.guard_draft();
create trigger deals_stage_activity before insert or update on public.deals
  for each row execute function app.deal_stage_activity();

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.tenants          enable row level security;
alter table public.tenant_members   enable row level security;
alter table public.platform_admins  enable row level security;
alter table public.industry_configs enable row level security;
alter table public.pipelines        enable row level security;
alter table public.pipeline_stages  enable row level security;
alter table public.companies        enable row level security;
alter table public.contacts         enable row level security;
alter table public.deals            enable row level security;
alter table public.tasks            enable row level security;
alter table public.message_drafts   enable row level security;
alter table public.activities       enable row level security;
alter table public.usage_events     enable row level security;
alter table public.audit_log        enable row level security;

-- tenants: members read; owner/admin update; creation only via app.create_tenant()
create policy tenants_select on public.tenants for select to authenticated
  using (app.is_member(id) or app.is_platform_admin());
create policy tenants_update on public.tenants for update to authenticated
  using (app.has_role(id, array['owner','admin']::public.member_role[]))
  with check (app.has_role(id, array['owner','admin']::public.member_role[]));

-- membership: members see co-members; owner/admin manage
create policy members_select on public.tenant_members for select to authenticated
  using (app.is_member(tenant_id));
create policy members_write on public.tenant_members for all to authenticated
  using (app.has_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = auth.uid());

-- configuration tables: members read; owner/admin write
create policy industry_configs_select on public.industry_configs for select to authenticated using (app.is_member(tenant_id));
create policy industry_configs_write  on public.industry_configs for all to authenticated
  using (app.has_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin']::public.member_role[]));
create policy pipelines_select on public.pipelines for select to authenticated using (app.is_member(tenant_id));
create policy pipelines_write  on public.pipelines for all to authenticated
  using (app.has_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin']::public.member_role[]));
create policy stages_select on public.pipeline_stages for select to authenticated using (app.is_member(tenant_id));
create policy stages_write  on public.pipeline_stages for all to authenticated
  using (app.has_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin']::public.member_role[]));

-- working data: all members read/insert/update; delete owner/admin/manager
do $$
declare t text;
begin
  foreach t in array array['companies','contacts','deals','tasks','message_drafts']
  loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (app.is_member(tenant_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (app.is_member(tenant_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (app.is_member(tenant_id)) with check (app.is_member(tenant_id))', t);
    execute format($p$create policy %1$s_delete on public.%1$I for delete to authenticated using (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]))$p$, t);
  end loop;
end $$;

-- event streams: members read and append; no update/delete for anyone but service role
create policy activities_select on public.activities for select to authenticated using (app.is_member(tenant_id));
create policy activities_insert on public.activities for insert to authenticated with check (app.is_member(tenant_id));
create policy usage_select on public.usage_events for select to authenticated
  using (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]));

-- audit log: owner/admin read; nobody writes directly (triggers only)
create policy audit_select on public.audit_log for select to authenticated
  using (app.has_role(tenant_id, array['owner','admin']::public.member_role[]) or app.is_platform_admin());

-- ---------------------------------------------------------------------
-- Tenant onboarding: creates tenant, owner membership, industry config
-- and default pipeline atomically. Stages come from the industry pack
-- (validated in application code) as a JSON array.
-- ---------------------------------------------------------------------
create or replace function app.create_tenant(
  p_name text, p_slug text, p_pack_id text, p_pack_version integer,
  p_stages jsonb, p_currency char(3) default 'USD'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_pipeline uuid;
  v_stage jsonb;
  v_pos integer := 0;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) < 2 then
    raise exception 'at least two pipeline stages are required' using errcode = '22023';
  end if;

  insert into public.tenants(name, slug, default_currency, trial_ends_at)
  values (p_name, p_slug, p_currency, now() + interval '14 days')
  returning id into v_tenant;

  insert into public.tenant_members(tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');
  insert into public.industry_configs(tenant_id, pack_id, pack_version, updated_by)
  values (v_tenant, p_pack_id, p_pack_version, v_uid);

  insert into public.pipelines(tenant_id, name, is_default) values (v_tenant, 'Sales', true)
  returning id into v_pipeline;

  for v_stage in select * from jsonb_array_elements(p_stages) loop
    insert into public.pipeline_stages(tenant_id, pipeline_id, key, label, position, kind, probability)
    values (v_tenant, v_pipeline, v_stage->>'key', v_stage->'label', v_pos,
            coalesce((v_stage->>'kind')::public.stage_kind, 'open'),
            (v_stage->>'probability')::numeric);
    v_pos := v_pos + 1;
  end loop;

  return v_tenant;
end $$;

-- ---------------------------------------------------------------------
-- Grants. app.* helpers are callable by authenticated users; tables are
-- exposed to authenticated only (anon gets nothing).
-- ---------------------------------------------------------------------
grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;
revoke execute on function app.audit(), app.guard_membership(), app.guard_draft(), app.deal_stage_activity() from authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
revoke insert, update, delete on public.usage_events from authenticated;
revoke insert, update, delete on public.platform_admins from authenticated;
revoke insert, delete on public.tenants from authenticated;
revoke update, delete on public.activities from authenticated;
revoke all on all tables in schema public from anon;
