-- Deleting a tenant cascades to its rows, whose audit triggers then tried to write audit_log rows
-- for a tenant that no longer exists (FK violation), so no tenant could ever be deleted.
-- The tenant's own audit trail is removed with it (on delete cascade), so there is nothing to record.
create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_tenant uuid := (v_row->>'tenant_id')::uuid;
begin
  if tg_op = 'DELETE' and v_tenant is not null and not exists (select 1 from public.tenants where id = v_tenant) then
    return old;
  end if;
  insert into public.audit_log(tenant_id, actor_id, action, entity_type, entity_id, before, after)
  values (
    v_tenant,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row->>'id', v_row->>'user_id', v_row->>'tenant_id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;
