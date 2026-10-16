-- Minimal stand-in for the parts of Supabase the migrations rely on.
-- auth.uid() mirrors Supabase's implementation (reads the JWT claim GUC).
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Stand-ins for Supabase extensions used by the agent migration (pg_net, pg_cron, vault, pgcrypto).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists extensions;
create or replace function extensions.gen_random_bytes(n int) returns bytea language sql as $$
  select decode(substr(repeat(md5(random()::text), 4), 1, n * 2), 'hex')
$$;
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create or replace function vault.create_secret(p_secret text, p_name text, p_description text default '') returns uuid language sql as $$
  insert into vault.secrets(name, secret, description) values (p_name, p_secret, p_description) returning id
$$;
create schema if not exists net;
create table if not exists net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, at timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$
  insert into net.calls(url, headers, body) values (url, headers, body) returning id
$$;
create schema if not exists cron;
create table if not exists cron.jobs (name text primary key, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.jobs values (job_name, schedule, command) on conflict (name) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint
$$;
