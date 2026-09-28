create extension if not exists pg_net with schema extensions;

-- The scheduler reads the encrypted token from Vault. The function only receives
-- its SHA-256 fingerprint, and browser users have no access to either record.
create table app.amazon_cron_auth (
  id boolean primary key default true check (id),
  token_hash bytea not null
);
alter table app.amazon_cron_auth enable row level security;
revoke all on app.amazon_cron_auth from public, anon, authenticated;
grant select on app.amazon_cron_auth to service_role;

do $$
declare token text := encode(gen_random_bytes(32), 'hex');
begin
  perform vault.create_secret(token, 'amazon_daily_sync_token');
  insert into app.amazon_cron_auth(id,token_hash) values(true,sha256(convert_to(token,'UTF8')));
end;
$$;

create function app.verify_amazon_cron_token(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_token is not null and length(p_token)=64 and exists (
    select 1 from app.amazon_cron_auth where id=true and token_hash=sha256(convert_to(p_token,'UTF8'))
  );
$$;
revoke all on function app.verify_amazon_cron_token(text) from public, anon, authenticated;
grant execute on function app.verify_amazon_cron_token(text) to service_role;

-- pg_cron uses UTC; 16:00 UTC is 01:00 the following day in Japan.
select cron.schedule('amazon-daily-inventory-sync', '0 16 * * *', $job$
  select net.http_post(
    url := 'https://xgoppuqoqeppckyunnvx.supabase.co/functions/v1/amazon-payments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-amazon-cron-token', (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token')
    ),
    body := '{"action":"daily"}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
notify pgrst, 'reload schema';
