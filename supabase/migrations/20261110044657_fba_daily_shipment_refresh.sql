alter table app.fba_inbound_plans add column received_at timestamptz;

-- Older plans may already contain exact received quantities from Amazon.
update app.fba_inbound_plans plan
set received_at = now()
where plan.stage = 'ready'
  and exists (select 1 from app.fba_inbound_items item where item.plan_id = plan.id)
  and not exists (
    select 1
    from app.fba_inbound_items item
    where item.plan_id = plan.id
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(plan.work->'shipments', '[]'::jsonb)) shipment
        where nullif(shipment->>'confirmationId', '') is not null
          and shipment->>'status' in ('DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED')
          and case when jsonb_typeof(shipment->'received'->item.sku) = 'number'
          then (shipment->'received'->>item.sku)::numeric >= 1 else false end
      )
  );

-- 16:00 UTC is 01:00 JST. Each plan has an independent request so a
-- remote failure on one plan does not stop the other plans.
select cron.schedule('fba-daily-shipment-refresh', '0 16 * * *', $job$
  select net.http_post(
    url := rtrim(config.project_url, '/') || '/functions/v1/amazon-fba-inbound',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-amazon-cron-token', config.token),
    body := jsonb_build_object('action', 'refresh', 'id', plan.id, 'revision', plan.revision),
    timeout_milliseconds := 120000
  )
  from app.fba_inbound_plans plan
  cross join (
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'delivery_push_project_url') project_url,
      (select decrypted_secret from vault.decrypted_secrets where name = 'amazon_daily_sync_token') token
  ) config
  where config.project_url is not null and config.token is not null
    and plan.stage = 'ready' and plan.pending is null and plan.amazon_id is not null
    and (
      plan.received_at is null or exists (
        select 1 from app.fba_inbound_items item
        where item.plan_id = plan.id and item.published_at is null and item.released_at is null
      )
    );
$job$);

notify pgrst, 'reload schema';

