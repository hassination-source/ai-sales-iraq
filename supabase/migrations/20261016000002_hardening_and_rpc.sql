-- Pin search_path on trigger helpers (Supabase linter 0011)
alter function app.forbid_tenant_change() set search_path = public, pg_temp;
alter function app.touch_updated_at() set search_path = public, pg_temp;

-- Functions are executable by PUBLIC by default; restrict app.* to signed-in users
revoke execute on all functions in schema app from public;
grant execute on function
  app.current_role_in(uuid), app.is_member(uuid), app.has_role(uuid, public.member_role[]),
  app.is_platform_admin(),
  app.create_tenant(text, text, text, integer, jsonb, char)
to authenticated;

-- Onboarding entry point exposed through the Supabase API (only `public` is exposed).
-- The web app validates the industry pack and passes its stages here.
create or replace function public.create_tenant(
  p_name text, p_slug text, p_pack_id text, p_pack_version integer,
  p_stages jsonb, p_currency char(3) default 'USD'
) returns uuid
language sql security invoker set search_path = public, pg_temp
as $$
  select app.create_tenant(p_name, p_slug, p_pack_id, p_pack_version, p_stages, p_currency)
$$;
revoke execute on function public.create_tenant(text, text, text, integer, jsonb, char) from public, anon;
grant execute on function public.create_tenant(text, text, text, integer, jsonb, char) to authenticated;
