-- =====================================================================
-- AI sales agent: missions, activity events, website research,
-- knowledge base and per-tenant agent settings. The agent worker is a
-- Supabase Edge Function using the service role; it scopes every query
-- by tenant explicitly. Users only ever see their tenant through RLS.
-- =====================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- settings
create table public.agent_settings (
  tenant_id          uuid primary key references public.tenants(id) on delete cascade,
  paused             boolean not null default false,
  daily_draft_limit  integer not null default 20 check (daily_draft_limit between 0 and 200),
  draft_language     text not null default 'ar-IQ' check (draft_language in ('ar-IQ','ar','en')),
  sender_name        text check (length(sender_name) <= 120),
  updated_by         uuid references auth.users(id),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------- knowledge base
create table public.knowledge_docs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null default 'other' check (kind in ('company','product','pricing','faq','policy','case_study','other')),
  title       text not null check (length(trim(title)) between 2 and 200),
  body        text not null check (length(body) between 10 and 20000),
  status      text not null default 'active' check (status in ('active','archived')),
  version     integer not null default 1,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create index knowledge_docs_tenant_idx on public.knowledge_docs(tenant_id, status);

create or replace function app.bump_doc_version()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.body is distinct from old.body or new.title is distinct from old.title then
    new.version := old.version + 1;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- missions
create table public.agent_missions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  kind          text not null default 'discover' check (kind in ('discover')),
  params        jsonb not null,                -- {segments:[], governorates:[], limit:int, write_drafts:bool}
  status        text not null default 'queued' check (status in ('queued','running','done','blocked','failed','cancelled')),
  phase         text not null default 'discover' check (phase in ('discover','research','draft','finished')),
  progress      jsonb not null default '{}',
  note          text,
  attempts      integer not null default 0,
  next_run_at   timestamptz not null default now(),
  locked_until  timestamptz,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  unique (tenant_id, id)
);
create index agent_missions_due_idx on public.agent_missions(status, next_run_at);

-- companies found by a mission (for "what did this mission find")
alter table public.companies add column mission_id uuid;
alter table public.companies add constraint companies_mission_fk
  foreign key (tenant_id, mission_id) references public.agent_missions(tenant_id, id) on delete set null (mission_id);
-- a directory record can only be added once per tenant (idempotent discovery)
create unique index companies_api_source_uq on public.companies(tenant_id, source_ref) where source_type = 'api' and source_ref is not null;

-- ---------------------------------------------------------------- research
create table public.company_research (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  company_id   uuid not null,
  url          text,
  status       text not null check (status in ('ok','failed','skipped')),
  title        text,
  description  text,
  text         text,
  emails       text[] not null default '{}',
  phones       text[] not null default '{}',
  language     text,
  error        text,
  fetched_at   timestamptz not null default now(),
  unique (tenant_id, company_id),
  foreign key (tenant_id, company_id) references public.companies(tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------- activity feed
create table public.agent_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  mission_id  uuid,
  type        text not null check (type ~ '^[a-z_.]+$'),
  level       text not null default 'info' check (level in ('info','success','warning','error')),
  data        jsonb not null default '{}',
  company_id  uuid,
  draft_id    uuid,
  created_at  timestamptz not null default now()
);
create index agent_events_feed_idx on public.agent_events(tenant_id, id desc);

-- ---------------------------------------------------------------- guards
-- Users may create missions and cancel them; everything else is the worker's job.
create or replace function app.guard_mission()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_active int;
begin
  if auth.uid() is null then return new; end if;  -- worker (service role)
  if tg_op = 'INSERT' then
    if new.status <> 'queued' or new.phase <> 'discover' or new.progress <> '{}'::jsonb then
      raise exception 'new missions must start queued' using errcode = '23514';
    end if;
    select count(*) into v_active from public.agent_missions
      where tenant_id = new.tenant_id and status in ('queued','running');
    if v_active >= 3 then
      raise exception 'at most 3 active missions at a time' using errcode = '23514';
    end if;
    new.created_by := auth.uid();
    return new;
  end if;
  if new.status <> 'cancelled' or old.status not in ('queued','running','blocked')
     or new.params is distinct from old.params or new.progress is distinct from old.progress or new.phase is distinct from old.phase then
    raise exception 'missions can only be cancelled by users' using errcode = '42501';
  end if;
  new.finished_at := now();
  return new;
end $$;

create or replace function app.validate_mission_params()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(new.params->'segments') <> 'array' or jsonb_array_length(new.params->'segments') not between 1 and 10
     or jsonb_typeof(new.params->'governorates') <> 'array' or jsonb_array_length(new.params->'governorates') not between 1 and 19
     or coalesce((new.params->>'limit')::int, 0) not between 1 and 200 then
    raise exception 'invalid mission parameters' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger agent_missions_guard before insert or update on public.agent_missions for each row execute function app.guard_mission();
create trigger agent_missions_params before insert on public.agent_missions for each row execute function app.validate_mission_params();
create trigger knowledge_docs_version before update on public.knowledge_docs for each row execute function app.bump_doc_version();
create trigger knowledge_docs_touch before update on public.knowledge_docs for each row execute function app.touch_updated_at();
create trigger agent_settings_touch before update on public.agent_settings for each row execute function app.touch_updated_at();
do $$
declare t text;
begin
  foreach t in array array['knowledge_docs','agent_missions','company_research','agent_events'] loop
    execute format('create trigger %I_tenant_immutable before update on public.%I for each row execute function app.forbid_tenant_change()', t, t);
  end loop;
  foreach t in array array['knowledge_docs','agent_settings','agent_missions'] loop
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function app.audit()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS
alter table public.agent_settings   enable row level security;
alter table public.knowledge_docs   enable row level security;
alter table public.agent_missions   enable row level security;
alter table public.company_research enable row level security;
alter table public.agent_events     enable row level security;

create policy agent_settings_select on public.agent_settings for select to authenticated using (app.is_member(tenant_id));
create policy agent_settings_write on public.agent_settings for all to authenticated
  using (app.has_role(tenant_id, array['owner','admin']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin']::public.member_role[]));

create policy knowledge_select on public.knowledge_docs for select to authenticated using (app.is_member(tenant_id));
create policy knowledge_write on public.knowledge_docs for all to authenticated
  using (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]));

create policy missions_select on public.agent_missions for select to authenticated using (app.is_member(tenant_id));
create policy missions_insert on public.agent_missions for insert to authenticated
  with check (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]));
create policy missions_cancel on public.agent_missions for update to authenticated
  using (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]))
  with check (app.has_role(tenant_id, array['owner','admin','manager']::public.member_role[]));

create policy research_select on public.company_research for select to authenticated using (app.is_member(tenant_id));
create policy events_select on public.agent_events for select to authenticated using (app.is_member(tenant_id));

grant select, insert, update, delete on public.agent_settings, public.knowledge_docs to authenticated;
grant select, insert, update on public.agent_missions to authenticated;
grant select on public.company_research, public.agent_events to authenticated;
revoke all on public.agent_settings, public.knowledge_docs, public.agent_missions, public.company_research, public.agent_events from anon;

-- ---------------------------------------------------------------- worker plumbing
-- Shared secret between the database (cron + kick) and the worker. Generated in the
-- database so it never leaves it except in the worker's request header.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'agent_worker_secret', 'Authenticates calls to the agent-worker edge function')
where not exists (select 1 from vault.secrets where name = 'agent_worker_secret');

create or replace function app.check_worker_secret(p_secret text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'agent_worker_secret' and decrypted_secret = p_secret)
$$;

-- Atomically claim due missions (skips paused tenants and missions another worker holds).
create or replace function app.claim_missions(p_limit int default 2)
returns setof public.agent_missions language sql security definer set search_path = public, pg_temp as $$
  update public.agent_missions m
     set status = 'running', locked_until = now() + interval '3 minutes',
         started_at = coalesce(m.started_at, now()), attempts = m.attempts + 1
   where m.id in (
     select x.id from public.agent_missions x
       left join public.agent_settings s on s.tenant_id = x.tenant_id
      where x.status in ('queued','running') and x.next_run_at <= now()
        and (x.locked_until is null or x.locked_until < now())
        and coalesce(s.paused, false) = false
      order by x.created_at
      limit p_limit
      for update of x skip locked)
  returning m.*
$$;

-- Ping the worker (used by cron and right after a mission is created).
create or replace function app.kick_agent_worker()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'agent_worker_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://oyxrldoxuqrjevllvsvr.supabase.co/functions/v1/agent-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000);
end $$;

create or replace function app.kick_on_new_mission()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.kick_agent_worker();
  return null;
end $$;
create trigger agent_missions_kick after insert on public.agent_missions for each statement execute function app.kick_on_new_mission();

-- Only the service role (the worker) may claim missions or check the secret.
revoke execute on function app.check_worker_secret(text), app.claim_missions(int), app.kick_agent_worker(), app.kick_on_new_mission() from public, authenticated, anon;
grant execute on function app.check_worker_secret(text), app.claim_missions(int) to service_role;
grant usage on schema app to service_role;

-- The worker talks to the database through the Supabase API, which only exposes `public`.
create or replace function public.worker_check_secret(p_secret text)
returns boolean language sql stable security invoker set search_path = public, pg_temp as $$ select app.check_worker_secret(p_secret) $$;
create or replace function public.worker_claim_missions(p_limit int default 2)
returns setof public.agent_missions language sql security invoker set search_path = public, pg_temp as $$ select * from app.claim_missions(p_limit) $$;
revoke execute on function public.worker_check_secret(text), public.worker_claim_missions(int) from public, authenticated, anon;
grant execute on function public.worker_check_secret(text), public.worker_claim_missions(int) to service_role;

-- Every minute: resume running missions and retry ones waiting on a busy source.
select cron.schedule('agent-worker-tick', '* * * * *', $$
  select app.kick_agent_worker()
  where exists (select 1 from public.agent_missions where status in ('queued','running') and next_run_at <= now())
$$);
