create table app.amazon_fba_removal_sync (like app.amazon_fba_return_sync including all);
alter table app.amazon_fba_removal_sync enable row level security;
revoke all on app.amazon_fba_removal_sync from public,anon,authenticated;
grant select,insert,update on app.amazon_fba_removal_sync to service_role;

alter table app.amazon_fba_customer_returns
  add column removal_order_id text,
  add column removal_shipped_on date,
  add column removal_carrier text,
  add column removal_tracking_no text;

create unique index amazon_fba_returns_removal_match
  on app.amazon_fba_customer_returns(account_id,source_sku,removal_order_id)
  where removal_order_id is not null;
create index amazon_fba_returns_source_sku
  on app.amazon_fba_customer_returns(account_id,source_sku,returned_on);

create function app.claim_amazon_fba_removal_sync(p_account_id text)
returns jsonb language plpgsql set search_path='' as $$
declare
  today date:=(now() at time zone 'Asia/Tokyo')::date;
  job app.amazon_fba_removal_sync;
  report_interval interval;
begin
  report_interval:=case when exists (
    select 1 from app.amazon_fba_customer_returns
    where account_id=p_account_id and item_id is not null and removal_order_id is null
      and returned_on>=today-90
  ) then interval '4 hours' else interval '1 day' end;
  insert into app.amazon_fba_removal_sync(account_id,import_from)
  values (p_account_id,today-89) on conflict (account_id) do nothing;
  update app.amazon_fba_removal_sync
  set lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes'
  where account_id=p_account_id and coalesce(lease_until,'-infinity')<=clock_timestamp()
    and coalesce(retry_at,'-infinity')<=clock_timestamp()
    and (report_id is not null or coalesce(completed_at,'-infinity')<=clock_timestamp()-report_interval)
  returning * into job;
  if not found then return null; end if;
  return jsonb_build_object('lease_id',job.lease_id,'report_id',job.report_id,'requested_at',job.requested_at,
    'report_from',today-89,'today',today);
end;
$$;

-- The shipment report identifies the removal order, not the customer's original order.
-- Only a one-unit shipment and a single earlier, linked return for the same SKU can be paired.
create function app.import_amazon_fba_removal_tracking(p_account_id text,p_lease_id uuid,p_report_id text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  group_row record;
  shipment record;
  target_item app.items;
  pending_since date;
  eligible_shipments integer;
  candidates uuid[];
  updated_count integer:=0;
  review_count integer:=0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 then
    raise exception 'Amazon返送出荷明細の形式が不正です' using errcode='22023';
  end if;
  perform 1 from app.amazon_fba_removal_sync where account_id=p_account_id and lease_id=p_lease_id
    and report_id=p_report_id and lease_until>clock_timestamp() for update;
  if not found then raise exception 'Amazon返送出荷明細の処理が更新されました'; end if;

  for group_row in select * from jsonb_to_recordset(p_rows) as g(source_sku text,shipments jsonb)
    order by source_sku loop
    select min(r.returned_on) into pending_since
    from app.amazon_fba_customer_returns r join app.items i on i.id=r.item_id
    where r.account_id=p_account_id and r.source_sku=group_row.source_sku
      and r.removal_order_id is null and r.registered_at is not null and r.quantity=1
      and i.marketplace='Amazon返品' and not i.is_accessory;
    if pending_since is null then continue; end if;

    for shipment in
      select s.*,count(*) over() as total
      from jsonb_to_recordset(group_row.shipments) as s(
        removal_order_id text,requested_on date,shipped_on date,quantity int,tracking_no text,carrier text
      )
      where s.requested_on>=pending_since
        and not exists (
          select 1 from app.amazon_fba_customer_returns r
          where r.account_id=p_account_id and r.source_sku=group_row.source_sku
            and r.removal_order_id=s.removal_order_id
        )
      limit 1
    loop
      eligible_shipments:=shipment.total;
      if eligible_shipments<>1 or shipment.quantity is distinct from 1
        or shipment.removal_order_id is null or length(shipment.removal_order_id) not between 1 and 128
        or shipment.shipped_on is null or shipment.shipped_on<shipment.requested_on
        or shipment.shipped_on>(now() at time zone 'Asia/Tokyo')::date
        or coalesce(shipment.tracking_no,'') !~ '^[A-Za-z0-9][A-Za-z0-9 .-]{0,127}$'
        or shipment.tracking_no !~ '[0-9]' then
        review_count:=review_count+1;
        continue;
      end if;
      select array_agg(r.item_id) into candidates
      from app.amazon_fba_customer_returns r
      where r.account_id=p_account_id and r.source_sku=group_row.source_sku
        and r.returned_on<=shipment.requested_on and r.removal_order_id is null;
      if cardinality(candidates) is distinct from 1 or candidates[1] is null then
        review_count:=review_count+1;
        continue;
      end if;

      select * into target_item from app.items i
      where i.id=candidates[1] and i.marketplace='Amazon返品' and not i.is_accessory for update;
      if not found then continue; end if;
      if nullif(btrim(target_item.tracking_no),'') is null then
        update app.items set tracking_no=shipment.tracking_no where id=target_item.id;
        updated_count:=updated_count+1;
      elsif upper(regexp_replace(target_item.tracking_no,'[ .-]','','g'))
        <>upper(regexp_replace(shipment.tracking_no,'[ .-]','','g')) then
        review_count:=review_count+1;
        continue;
      end if;
      update app.amazon_fba_customer_returns
      set removal_order_id=shipment.removal_order_id,removal_shipped_on=shipment.shipped_on,
        removal_carrier=nullif(left(shipment.carrier,100),''),removal_tracking_no=shipment.tracking_no
      where item_id=target_item.id and account_id=p_account_id and source_sku=group_row.source_sku
        and removal_order_id is null;
    end loop;
  end loop;
  return jsonb_build_object('updated',updated_count,'review',review_count);
end;
$$;

revoke all on function app.claim_amazon_fba_removal_sync(text),
  app.import_amazon_fba_removal_tracking(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function app.claim_amazon_fba_removal_sync(text),
  app.import_amazon_fba_removal_tracking(text,uuid,text,jsonb) to service_role;
notify pgrst, 'reload schema';
