alter table app.amazon_seller_inventory_sync
  add column last_active_listings jsonb,
  add column last_unknown_rows integer,
  add column last_missing_items jsonb;

create function app.apply_seller_inventory_report(
  p_account text, p_lease uuid, p_report text, p_snapshot timestamptz, p_rows jsonb, p_unknown integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous app.amazon_seller_inventory_sync;
  result jsonb;
  missing jsonb;
  stopped integer := 0;
begin
  if p_unknown is null or p_unknown < 0 then
    raise exception 'Invalid count of unreadable inventory rows';
  end if;
  select * into strict previous from app.amazon_seller_inventory_sync s
    where s.account_id=p_account and s.lease_id=p_lease and s.report_id=p_report for update;
  result := app.apply_seller_inventory_report(p_account,p_lease,p_report,p_snapshot,p_rows);
  if coalesce((result->>'stale')::boolean,false) then
    return result;
  end if;

  -- Allow for the report cache and newly registered listings. Only stop
  -- inventory missing from two complete reports over six hours apart.
  if p_unknown=0 then
    with reported_skus as materialized (
      select r->>'sku' sku from jsonb_array_elements(p_rows) r
    ), candidates as materialized (
      select i.id,i.sku,btrim(i.asin::text) asin,i.sales_channel::text channel,
        i.product_registered_at registered_at,i.marketplace_status_observed_at observed_at
      from app.items i
      where i.status='出品中' and i.sold_on is null and i.returned_on is null
        and i.product_registered_at <= p_snapshot
        and coalesce(i.marketplace_status_observed_at, i.product_registered_at) <= p_snapshot
        and btrim(i.asin::text) ~ '^[0-9A-Z]{10}$'
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
        and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
        and case p_account
          when 'amazon-2' then i.sales_channel::text in ('FBA2','自己発送2')
          else i.sales_channel::text in ('FBA','FBA1','自己発送','自己発送1') end
        and not exists(select 1 from reported_skus r where r.sku=i.sku)
        and not exists(select 1 from app.item_sku_aliases a join reported_skus r on r.sku=a.sku where a.item_id=i.id)
    ), observations as (
      select c.*,
        case when observation->>'sku'=c.sku and observation->>'asin'=c.asin and observation->>'channel'=c.channel
          and (observation->>'registered_at')::timestamptz=c.registered_at
          and (observation->>'since')::timestamptz >= coalesce(c.observed_at,c.registered_at)
        then (observation->>'since')::timestamptz else p_snapshot end since
      from candidates c
      cross join lateral (select previous.last_missing_items->c.id::text observation) prior
    ), changed as (
      update app.items i set status='出品停止', marketplace_status_observed_at=p_snapshot
      from observations o
      where i.id=o.id and o.since < p_snapshot - interval '6 hours'
        and i.sku=o.sku and btrim(i.asin::text)=o.asin and i.sales_channel::text=o.channel
        and i.product_registered_at=o.registered_at and coalesce(i.marketplace_status_observed_at,o.registered_at)<=o.since
        and i.status='出品中' and i.sold_on is null and i.returned_on is null
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
      returning i.id
    )
    select count(changed.id)::integer, jsonb_object_agg(o.id::text,
      jsonb_build_object('sku',o.sku,'asin',o.asin,'channel',o.channel,'registered_at',o.registered_at,'since',o.since))
      filter (where changed.id is null)
    into stopped,missing
    from observations o left join changed using(id);
  end if;

  result := result || jsonb_build_object('inactive',(result->>'inactive')::integer+stopped,'missing_stopped',stopped);
  update app.amazon_seller_inventory_sync s
  set last_active_listings = (
    select coalesce(jsonb_agg(r order by r->>'sku'),'[]'::jsonb)
    from jsonb_array_elements(p_rows) r where r->>'state'='active'
  ), last_unknown_rows=p_unknown, last_missing_items=missing, last_result=result
  where s.account_id=p_account;
  return result;
end $$;

-- The admin view compares the latest Amazon listing SKUs with current inventory.
-- Compare SKU sets, since equal totals can still hide an extra and a missing SKU.
create function app.read_amazon_listing_sync_status()
returns table (
  account_id text, snapshot_at timestamptz, pending boolean, last_error text, unknown_rows integer,
  seller_count integer, inventory_count integer, amazon_only text[], inventory_only text[]
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(app.is_admin(),false) then
    raise exception '管理者のみ利用できます' using errcode = '42501';
  end if;

  return query
  with inventory as materialized (
    select i.id,i.sku,btrim(i.asin::text) asin,
      case when i.sales_channel::text in ('FBA2','自己発送2') then 'amazon-2' else 'amazon-1' end account,
      case when i.sales_channel::text in ('FBA','FBA1','FBA2') then 'fba' else 'self' end fulfillment
    from app.items i
    where i.sales_channel::text in ('FBA','FBA1','FBA2','自己発送','自己発送1','自己発送2')
      and i.status='出品中'
      and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
  ), inventory_skus as (
    select i.id,i.sku,i.asin,i.account,i.fulfillment from inventory i
    union
    select i.id,a.sku,i.asin,i.account,i.fulfillment
    from inventory i join app.item_sku_aliases a on a.item_id=i.id
  ), listings as materialized (
    select s.account_id account, r.sku,r.asin,r.fulfillment
    from app.amazon_seller_inventory_sync s
    cross join lateral jsonb_to_recordset(s.last_active_listings) r(sku text,asin text,fulfillment text)
  ), matches as (
    select r.account,r.sku,(array_agg(i.id))[1] id
    from listings r join inventory_skus i
      on i.account=r.account and i.sku=r.sku and i.asin=r.asin and i.fulfillment=r.fulfillment
    group by r.account,r.sku
    having count(distinct i.id)=1
  ), unique_matches as (
    select m.account,m.sku,m.id from matches m
    where not exists(select 1 from matches also where also.account=m.account and also.id=m.id and also.sku<>m.sku)
  )
  select s.account_id,s.last_snapshot_at,s.report_id is not null,s.last_error,s.last_unknown_rows,
    case when s.last_active_listings is not null then (select count(*)::integer from listings r where r.account=s.account_id) end,
    (select count(*)::integer from inventory i where i.account=s.account_id),
    case when s.last_active_listings is not null then array(
      select r.sku from listings r where r.account=s.account_id
        and not exists(select 1 from unique_matches m where m.account=r.account and m.sku=r.sku)
      order by r.sku
    ) end,
    case when s.last_active_listings is not null then array(
      select i.sku from inventory i where i.account=s.account_id
        and not exists(select 1 from unique_matches m where m.account=i.account and m.id=i.id)
      order by i.sku
    ) end
  from app.amazon_seller_inventory_sync s
  order by s.account_id;
end $$;

revoke all on function app.apply_seller_inventory_report(text,uuid,text,timestamptz,jsonb,integer)
  from public,anon,authenticated;
grant execute on function app.apply_seller_inventory_report(text,uuid,text,timestamptz,jsonb,integer) to service_role;
revoke all on function app.read_amazon_listing_sync_status() from public,anon,authenticated;
grant execute on function app.read_amazon_listing_sync_status() to authenticated;

notify pgrst,'reload schema';
