-- Retain the Amazon listing state through edits to inventory and work dates.
do $$
declare d text := pg_get_functiondef('app.items_sync_status()'::regprocedure);
begin
  if strpos(d, 'elsif new.status=''出品中'' then') = 0 then
    raise exception 'Unexpected inventory workflow function';
  end if;
  d := replace(d, 'elsif new.status=''出品中'' then',
    'elsif new.status=''出品停止'' then return new; elsif new.status=''出品中'' then');
  d := replace(d, 'not explicit_change and new.status=''出品中''',
    'not explicit_change and new.status in (''出品中'',''出品停止'')');
  execute d;
end $$;

create table app.amazon_seller_inventory_sync (
  account_id text primary key check (account_id in ('amazon-1','amazon-2')),
  report_id text,
  lease_id uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  next_poll_at timestamptz,
  last_snapshot_at timestamptz,
  last_result jsonb,
  last_error text
);
alter table app.amazon_seller_inventory_sync enable row level security;
revoke all on app.amazon_seller_inventory_sync from public, anon, authenticated;
grant select, update on app.amazon_seller_inventory_sync to service_role;
insert into app.amazon_seller_inventory_sync (account_id) values ('amazon-1'), ('amazon-2');

create function app.claim_seller_inventory_report(p_account text, p_manual boolean)
returns jsonb language sql security definer set search_path = '' as $$
  update app.amazon_seller_inventory_sync as s
  set lease_id = gen_random_uuid(),
      lease_until = now() + interval '3 minutes',
      last_started_at = case when report_id is null then now() else last_started_at end
  where s.account_id = p_account
    and (s.lease_until is null or s.lease_until < now())
    and case when s.report_id is not null then
      p_manual or coalesce(s.next_poll_at, '-infinity') <= now()
    else
      s.last_started_at is null or
      (p_manual and s.last_started_at < now() - interval '1 hour') or
      (((s.last_started_at - interval '1 hour') at time zone 'Asia/Tokyo')::date
        < ((now() - interval '1 hour') at time zone 'Asia/Tokyo')::date)
    end
  returning jsonb_build_object('lease_id', s.lease_id, 'report_id', s.report_id, 'last_started_at', s.last_started_at);
$$;

create function app.apply_seller_inventory_report(
  p_account text, p_lease uuid, p_report text, p_snapshot timestamptz, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job app.amazon_seller_inventory_sync;
  result jsonb;
begin
  select * into strict job from app.amazon_seller_inventory_sync
  where account_id=p_account and lease_id=p_lease and report_id=p_report and lease_until>now()
  for update;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0
      or p_snapshot is null or p_snapshot > now() + interval '5 minutes'
      or p_snapshot < now() - interval '1 day' then
    raise exception 'Invalid inventory report';
  end if;

  if p_snapshot <= job.last_snapshot_at then
    result := jsonb_build_object('active',0,'inactive',0,'matched',0,'stale',true);
  else
    with report as materialized (
      select sku,asin,fulfillment,state,
        case p_account when 'amazon-2' then array[case fulfillment when 'fba' then 'FBA2' else '自己発送2' end]
        else case fulfillment when 'fba' then array['FBA1','FBA'] else array['自己発送1','自己発送'] end end as channels
      from jsonb_to_recordset(p_rows) as r(sku text,asin text,fulfillment text,state text)
      where sku <> '' and asin ~ '^[0-9A-Z]{10}$' and fulfillment in ('fba','self') and state in ('active','inactive')
    ), candidates as (
      select r.sku, r.state, i.id
      from report r join app.items i on i.sku=r.sku and btrim(i.asin::text)=r.asin and i.sales_channel::text=any(r.channels)
      union
      select r.sku, r.state, i.id
      from report r join app.item_sku_aliases a on a.sku=r.sku
      join app.items i on i.id=a.item_id and btrim(i.asin::text)=r.asin and i.sales_channel::text=any(r.channels)
    ), unique_skus as (
      select sku from candidates group by sku having count(distinct id)=1 and count(distinct state)=1
    ), matched as (
      select id, bool_or(state='active') as active
      from candidates join unique_skus using(sku)
      group by id
    ), changed as (
      update app.items i
      set status=case when m.active then '出品中'::app.item_status else '出品停止'::app.item_status end,
          marketplace_status_observed_at=p_snapshot,
          product_registered_at=case when m.active then coalesce(i.product_registered_at,p_snapshot) else i.product_registered_at end
      from matched m where i.id=m.id
        and i.sold_on is null and i.returned_on is null
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
        and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
        and (i.marketplace_status_observed_at is null or i.marketplace_status_observed_at <= p_snapshot)
        and ((m.active and i.status in ('商品登録前','出品停止')) or (not m.active and i.status='出品中'))
      returning i.status
    )
    select jsonb_build_object('active',count(*) filter(where status='出品中'),
      'inactive',count(*) filter(where status='出品停止'), 'matched',(select count(*) from matched),
      'rows',jsonb_array_length(p_rows)) into result from changed;
  end if;

  update app.amazon_seller_inventory_sync
  set report_id=null, lease_id=null, lease_until=null, next_poll_at=null, last_error=null,
      last_snapshot_at=greatest(p_snapshot,last_snapshot_at), last_result=result
  where account_id=p_account;
  return result;
end $$;

revoke all on function app.claim_seller_inventory_report(text,boolean),
  app.apply_seller_inventory_report(text,uuid,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function app.claim_seller_inventory_report(text,boolean),
  app.apply_seller_inventory_report(text,uuid,text,timestamptz,jsonb) to service_role;

-- The physical shipment refresh can close a received plan once the listing is active.
-- It no longer changes the listing status itself.
create or replace function app.publish_fba_inbound_items(p_plan uuid,p_items uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare published_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception '内部処理専用です' using errcode = '42501';
  end if;
  update app.fba_inbound_items f set published_at=now(),released_at=now()
  from app.fba_inbound_plans p, app.items i
  where p.id=p_plan and f.plan_id=p.id and p.stage='ready' and p.pending is null
    and f.released_at is null and f.published_at is null
    and i.id=f.item_id and i.id=any(p_items)
    and app.inventory_sku_matches(i.id,i.sku,f.sku)
    and btrim(i.asin::text)=f.asin and i.condition::text=f.condition and i.deliverer_id=p.staff_id
    and i.status='出品中' and i.sold_on is null and i.returned_on is null
    and (i.sales_channel::text=p.account or (i.sales_channel::text='FBA' and p.account='FBA1'))
    and exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p.work->'shipments')='array'
        then p.work->'shipments' else '[]'::jsonb end) shipment
      where nullif(shipment->>'confirmationId','') is not null
        and shipment->>'status' in ('DELIVERED','CHECKED_IN','RECEIVING','CLOSED')
        and case when jsonb_typeof(shipment->'received'->f.sku)='number'
          then (shipment->'received'->>f.sku)::numeric >= 1 else false end
    );
  get diagnostics published_count=row_count;
  return published_count;
end $$;

select cron.unschedule(jobid) from cron.job where jobname='amazon-self-listing-status-refresh';
select cron.schedule('amazon-seller-inventory-refresh', '*/5 * * * *', $job$
  with config as (
    select
      (select decrypted_secret from vault.decrypted_secrets where name='delivery_push_project_url') project_url,
      (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token') token
  )
  select net.http_post(
    url := rtrim(project_url,'/') || '/functions/v1/amazon-seller-inventory',
    headers := jsonb_build_object('Content-Type','application/json','x-amazon-cron-token',token),
    body := '{}'::jsonb, timeout_milliseconds := 120000
  )
  from config where project_url is not null and token is not null and exists (
    select 1 from app.amazon_seller_inventory_sync s
    where (s.lease_until is null or s.lease_until<now())
      and ((s.report_id is not null and coalesce(s.next_poll_at,'-infinity')<=now())
        or (s.report_id is null and (s.last_started_at is null
          or ((s.last_started_at-interval '1 hour') at time zone 'Asia/Tokyo')::date
            < ((now()-interval '1 hour') at time zone 'Asia/Tokyo')::date)))
  );
$job$);
notify pgrst, 'reload schema';
