-- The agent worker runs as a route in the web app (deployed with every git push)
-- instead of a separately deployed edge function. Its address is configuration.
select vault.create_secret('https://ai-sales-iraq.vercel.app/api/agent/tick', 'agent_worker_url', 'Where the database sends agent ticks')
where not exists (select 1 from vault.secrets where name = 'agent_worker_url');

create or replace function app.kick_agent_worker()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_secret text; v_url text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'agent_worker_secret';
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'agent_worker_url';
  if v_secret is null or v_url is null then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000);
end $$;
revoke execute on function app.kick_agent_worker() from public, authenticated, anon;
