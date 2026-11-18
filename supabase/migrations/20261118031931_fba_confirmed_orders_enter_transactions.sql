-- Confirmed FBA orders enter transactions; retire inventory-out-of-stock workflow.
CREATE OR REPLACE FUNCTION app.apply_seller_inventory_report(p_account text, p_lease uuid, p_report text, p_snapshot timestamp with time zone, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  job app.amazon_seller_inventory_sync;
  result jsonb; previous_observation text := current_setting('app.seller_inventory_observation',true);
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
    perform set_config('app.seller_inventory_observation','on',true); with report as materialized (
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
      set status='出品中',
          marketplace_status_observed_at=p_snapshot,
          product_registered_at=coalesce(i.product_registered_at,p_snapshot)
      from matched m where i.id=m.id and m.active
        and i.sold_on is null and i.returned_on is null
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
        and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
        and (i.marketplace_status_observed_at is null or i.marketplace_status_observed_at <= p_snapshot)
        and i.status='商品登録前'
      returning i.status
    )
    select jsonb_build_object('active',count(*) filter(where status='出品中'),
      'inactive',0, 'matched',(select count(*) from matched),
      'rows',jsonb_array_length(p_rows)) into result from changed; perform set_config('app.seller_inventory_observation',coalesce(previous_observation,''),true);
  end if;

  update app.amazon_seller_inventory_sync
  set report_id=null, lease_id=null, lease_until=null, next_poll_at=null, last_error=null,
      last_snapshot_at=greatest(p_snapshot,last_snapshot_at), last_result=result
  where account_id=p_account;
  return result;
end $function$
;
create or replace function app.apply_seller_inventory_report(
  p_account text,p_lease uuid,p_report text,p_snapshot timestamptz,p_rows jsonb,p_unknown integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if p_unknown is null or p_unknown<0 then raise exception 'Invalid count of unreadable inventory rows';end if;
  perform 1 from app.amazon_seller_inventory_sync
    where account_id=p_account and lease_id=p_lease and report_id=p_report for update;
  if not found then raise exception 'Inventory report lease does not match';end if;
  result:=app.apply_seller_inventory_report(p_account,p_lease,p_report,p_snapshot,p_rows);
  if coalesce((result->>'stale')::boolean,false) then return result;end if;
  -- Missing/inactive offers do not establish that an order exists.
  result:=result||jsonb_build_object('inactive',0,'missing_stopped',0);
  update app.amazon_seller_inventory_sync
  set last_active_listings=(select coalesce(jsonb_agg(r order by r->>'sku'),'[]'::jsonb)
    from jsonb_array_elements(p_rows) r where r->>'state'='active'),
    last_unknown_rows=p_unknown,last_missing_items=null,last_result=result
  where account_id=p_account;
  return result;
end $$;

CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app'
AS $function$
declare explicit_change boolean:=false; parent_status app.item_status;
begin
 if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.cost_amount:=0;end if;
 if new.is_accessory and new.parent_item_id is not null and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   select status into parent_status from app.items where id=new.parent_item_id;
   if found then new.status:=parent_status;return new;end if;
 end if;
 -- Sale dates always win, including delayed browser snapshots and photo actions.
 if new.sold_on is not null then new.status:='販売済';return new;end if;
 if new.status='返品処理' or new.returned_on is not null then new.status:='返品処理';return new;end if;
 if tg_op='UPDATE' then explicit_change:=new.status is distinct from old.status;end if;
 if explicit_change then
   if new.marketplace_status_observed_at is not distinct from old.marketplace_status_observed_at then new.marketplace_status_observed_at:=now();end if;
   if new.status='販売済' then
     new.sold_on:=(now() at time zone 'Asia/Tokyo')::date;
     new.sold_price:=0;new.payout_amount:=0;return new;
   elsif new.status='Amazon返送依頼' then new.return_request_completed_at:=null;return new;
   elsif new.status='検品中' then
     if new.marketplace not in ('Amazon返品','動作品Amazon返品') and nullif(btrim(new.tracking_no),'') is null then raise exception '検品中にするには追跡番号を登録してください' using errcode='22023';end if;
     if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.return_request_completed_at:=coalesce(new.return_request_completed_at,now());end if;
     new.inspected_at:=null;new.product_registered_at:=null;
     return new;
   elsif new.status='商品登録前' then
     new.product_registered_at:=null;new.inspected_at:=coalesce(new.inspected_at,now());
     new.malfunction_resolved_at:=case when new.malfunction_reported then coalesce(new.malfunction_resolved_at,now()) else new.malfunction_resolved_at end;
     return new;
   elsif new.status='出品停止' then raise exception 'この販売状態は廃止されました。在庫を再読み込みしてください。' using errcode='22023'; elsif new.status='出品中' then
     new.product_registered_at:=coalesce(new.product_registered_at,now());return new;
   elsif new.status='動作不良' then new.malfunction_reported:=true;new.malfunction_resolved_at:=null;return new;
   elsif new.status in ('取引中','Amazon補填申請中') then return new;
   end if;
 end if;
 -- These stages require a business decision, not a shipping/photo timestamp.
 if tg_op='UPDATE' and new.sales_channel is not distinct from old.sales_channel
 and new.status in ('取引中','Amazon補填申請中')
 and new.malfunction_reported is not distinct from old.malfunction_reported then return new;end if;
 if tg_op='UPDATE' and not explicit_change and new.status='出品中'
 and new.product_registered_at is not distinct from old.product_registered_at
 and new.sales_channel is not distinct from old.sales_channel
 and not coalesce(new.malfunction_reported and new.malfunction_resolved_at is null,false) then return new;end if;
 if new.malfunction_reported and new.malfunction_resolved_at is null then new.status:='動作不良';
 elsif new.product_registered_at is not null then new.status:='出品中';
 elsif new.inspected_at is not null or (new.malfunction_resolved_at is not null and new.sales_channel='ヤフオク') then new.status:='商品登録前';
 elsif new.marketplace in ('Amazon返品','動作品Amazon返品') then
   new.status:=case when new.return_request_completed_at is not null then '検品中'::app.item_status else 'Amazon返送依頼'::app.item_status end;
 elsif nullif(btrim(new.tracking_no),'') is not null then new.status:='検品中';
 else new.status:='受取前';end if;
 return new;
end $function$
;
CREATE OR REPLACE FUNCTION app.record_amazon_sale_page(p_account text, p_lease uuid, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  activation timestamptz;
  item app.items;
  r record;
  channel text;
  label text;
  queued integer:=0;
  item_price text;
begin
  select enabled_at into strict activation from app.amazon_sale_poll
  where account_id=p_account and lease_id=p_lease and lease_until>now() for update;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>200 then
    raise exception 'Invalid orders page';
  end if;
  for r in select * from jsonb_to_recordset(p_rows) as x(order_id text,line_id text,sku text,asin text,product_title text,
     fulfillment text,purchased_at timestamptz,amount integer) loop
    if r.purchased_at is null or r.purchased_at < activation or r.purchased_at > now()
      or coalesce(r.order_id,'') !~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$' or length(coalesce(r.line_id,'')) not between 1 and 80
      or length(coalesce(r.sku,'')) not between 1 and 160 or coalesce(r.asin,'') !~ '^[A-Z0-9]{10}$'
      or coalesce(r.fulfillment,'') not in ('AMAZON','MERCHANT') then continue;end if;
    channel := (case r.fulfillment when 'AMAZON' then 'FBA' else '自己発送' end);
    label := (case p_account when 'amazon-1' then 'Amazon1' else 'Amazon2' end)||'（'||channel||'）';
    select i.* into item from app.items i
    where i.id=(select min(m.id::text)::uuid from app.items m where btrim(m.asin::text)=r.asin
      and (m.sales_channel::text=channel||right(p_account,1) or (p_account='amazon-1' and m.sales_channel::text=channel))
      and app.inventory_sku_matches(m.id,m.sku,r.sku) having count(*)=1);
    -- A confirmed FBA order changes inventory state before financial settlement.
    -- Never infer a sale from zero stock, or reopen final/returned/problem items.
    if r.fulfillment='AMAZON' and item.id is not null then
      update app.items i set status='取引中'
      where i.id=item.id and i.status='出品中'
        and i.sold_on is null and i.returned_on is null
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
        and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
        and i.sales_channel::text in ('FBA','FBA1','FBA2')
        and r.purchased_at >= coalesce(i.product_registered_at,
          i.purchased_at::timestamp at time zone 'Asia/Tokyo')
        and (i.purchased_at is null or (r.purchased_at at time zone 'Asia/Tokyo')::date >= i.purchased_at);
    end if;
    item_price := case when r.amount>0 then '｜'||to_char(r.amount,'FM999,999,990')||'円' end;
    if app.record_sale_notice(jsonb_build_array(p_account,r.order_id,r.line_id)::text,item.id,
      concat(label,'で売れました｜【',coalesce(app.product_serial(item.sku,item.lot_seq),left(r.sku,45)),'】',
        left(coalesce(item.title,r.product_title,''),100),item_price)) then queued:=queued+1;end if;
  end loop;
  return queued;
end $function$
;
-- Repair only the retired state; settled amounts and dates remain untouched.
do $$
declare target record; confirmed boolean;
begin
  for target in select i.* from app.items i where i.status='出品停止'
    and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
    order by i.id for update
  loop
    select exists(select 1 from app.sale_notices n
      cross join lateral(select case
        when n.source_key ~ '^\s*\[\s*"amazon-[12]"' then n.source_key::jsonb end key) evidence
      where n.item_id=target.id and jsonb_typeof(evidence.key)='array'
        and jsonb_array_length(evidence.key)=3
        and evidence.key->>0=case target.sales_channel::text when 'FBA2' then 'amazon-2' else 'amazon-1' end
        and (evidence.key->>1) ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
        and nullif(evidence.key->>2,'') is not null
        and n.created_at>=coalesce(target.product_registered_at,target.purchased_at::timestamp at time zone 'Asia/Tokyo')
        and target.sales_channel::text in ('FBA','FBA1','FBA2')
        and target.sold_on is null and target.returned_on is null
        and not coalesce(target.malfunction_reported and target.malfunction_resolved_at is null,false)
    ) into confirmed;
    update app.items set status=case when confirmed then '取引中'::app.item_status else '出品中'::app.item_status end
      where id=target.id and status='出品停止';
  end loop;
  -- Linked accessories normally follow the parent trigger; also repair any orphaned legacy rows.
  update app.items a set status=coalesce((select p.status from app.items p where p.id=a.parent_item_id),'出品中'::app.item_status)
    where a.status='出品停止' and a.is_accessory;
  if exists(select 1 from app.items where status='出品停止') then raise exception 'Retired inventory state remains';end if;
end $$;
update app.amazon_seller_inventory_sync set last_missing_items=null;
