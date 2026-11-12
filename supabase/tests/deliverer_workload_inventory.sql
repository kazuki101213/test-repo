\set ON_ERROR_STOP on
-- Disposable CI fixtures only. No production transactions or external actions.
begin;
insert into app.staff(id,code,name,role) values('99665000-0000-0000-0000-000000000001','QW','workload metric fixture','deliverer');
insert into app.staff(id,code,name,role) values
 ('99665000-0000-0000-0000-000000000002','QX','workload historical assignee','purchaser'),
 ('99665000-0000-0000-0000-000000000003','QZ','workload never assigned','purchaser');
insert into app.items(lot_seq,sku,purchaser_id,deliverer_id,title,cost_amount,marketplace,sales_channel,sold_on)
values(996649,'996649-AAQX-20261019-100',(select id from app.staff where code='AA'),
 '99665000-0000-0000-0000-000000000002','workload historical item',100,'ヤフオク','メルカリ',current_date);
create temporary table workload_cases(id uuid default gen_random_uuid(),n serial,status app.item_status,channel app.sales_channel,shipped_on date,is_accessory boolean,expected_held boolean,expected_working boolean);
insert into workload_cases(status,channel,shipped_on,is_accessory,expected_held,expected_working)
select status::app.item_status,channel::app.sales_channel,shipped_on,is_accessory,not is_accessory,not is_accessory and status in ('検品中','Amazon返送依頼','商品登録前')
from unnest(array['受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良']) status
cross join unnest(array['自己発送','メルカリ','ヤフオク','FBA','ヤフフリ',null]) channel
cross join unnest(array[null::date,current_date]) shipped_on cross join unnest(array[false,true]) is_accessory;
insert into workload_cases(status,channel,shipped_on,is_accessory,expected_held,expected_working)
select status::app.item_status,channel::app.sales_channel,shipped_on,is_accessory,
not is_accessory and coalesce(channel in ('自己発送','メルカリ','ヤフオク'),false) and (status='出品中' or (status='取引中' and shipped_on is null)),false
from unnest(array['出品中','取引中','販売済','返品処理']) status
cross join unnest(array['自己発送','メルカリ','ヤフオク','FBA','ヤフフリ',null]) channel
cross join unnest(array[null::date,current_date]) shipped_on cross join unnest(array[false,true]) is_accessory;
insert into app.products(asin,model_no) values ('B0WORK2084','WORKLOAD-MODEL');
insert into app.items(id,lot_seq,sku,purchaser_id,deliverer_id,title,cost_amount,marketplace,sales_channel,tracking_no,is_accessory,asin)
select id,996650+n,(996650+n)::text||case when is_accessory then 'c' else '' end||'-AAQW-20261019-100',
  (select id from app.staff where code='AA'),'99665000-0000-0000-0000-000000000001',
  case when legacy_return then 'X001E8Z9QH' else 'workload metric fixture' end,100,
  (case when legacy_return then '動作品Amazon返品' else 'ヤフオク' end)::app.marketplace,
  channel,case when status='受取前' then null else 'tracking' end,is_accessory,
  case when legacy_return then 'B0WORK2084' end
from workload_cases
cross join lateral (select not is_accessory and status='商品登録前' and channel='FBA' and shipped_on is null as legacy_return) fixture;
update app.items i set status=c.status,shipped_on=c.shipped_on from workload_cases c where i.id=c.id;
do $$begin if exists(select 1 from app.items i join workload_cases c using(id) where i.status<>c.status) then raise exception 'Fixture status changed by workflow validation';end if;end $$;

-- One SKU received, one still in another shipment, and a legacy FBA listing with no receipt.
with chosen as (
 select i.id, i.sku, i.title, i.sales_channel
 from app.items i join workload_cases c using(id)
 where not c.is_accessory and c.channel = 'FBA' and c.shipped_on is null
 and c.status in ('出品中','商品登録前')
), plan as (
 insert into app.fba_inbound_plans(account,staff_id,name,created_by,stage,work)
 select 'FBA1','99665000-0000-0000-0000-000000000001','workload split plan',
  '11111111-1111-1111-1111-111111111111','ready',
  jsonb_build_object('shipments',jsonb_build_array(
    jsonb_build_object('confirmationId','ready-shipment','status','RECEIVING',
      'received',jsonb_build_object(listed.sku,1)),
    jsonb_build_object('confirmationId','open-shipment','status','WORKING',
      'boxes',jsonb_build_array(jsonb_build_object('skus',jsonb_build_array(registration.sku))))
  ))
 from chosen listed join workload_cases l on l.id=listed.id and l.status='出品中'
 cross join chosen registration join workload_cases r on r.id=registration.id and r.status='商品登録前'
 returning id
)
insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel)
select plan.id,chosen.id,chosen.sku,'B000000001',chosen.title,'良い',chosen.sales_channel from plan cross join chosen;
-- Amazon receipts keep the original SKU while inventory follows the cost.
update app.items i set cost_amount=130
from workload_cases c where i.id=c.id and not c.is_accessory and c.status='出品中'
  and c.channel='FBA' and c.shipped_on is null;

grant select on workload_cases to authenticated;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$ declare actual record;begin
 select * into actual from app.v_deliverer_workload where deliverer_id='99665000-0000-0000-0000-000000000001';
 if not found then raise exception 'Workload fixture missing';end if;
 if actual."保有在庫"<>(select count(*) from workload_cases where expected_held) then raise exception 'Held count mismatch: %',actual."保有在庫";end if;
 if actual."作業在庫"<>(select count(*) from workload_cases where expected_working) then raise exception 'Working count mismatch: %',actual."作業在庫";end if;
end $$;
do $$ declare summary record; bad integer; begin
 select * into strict summary from app.v_deliverer_stock_workload where deliverer_id='99665000-0000-0000-0000-000000000001';
 if summary.listed_in_fba <> 1 or summary.listed_on_hand <> 4 then
   raise exception 'Incorrect FBA or local listings: %',summary;
 end if;
 if summary.amazon_returns <> (select count(*) from workload_cases where status='Amazon返送依頼' and not is_accessory) then
   raise exception 'Incorrect Amazon return count: %',summary;
 end if;
 select count(*) into bad from app.v_deliverer_stock_workload_items i join workload_cases c using(id)
 where (c.status='検品中' and i.on_hand)
   or (c.status='Amazon返送依頼' and (i.bucket is distinct from 'Amazon返品' or i.on_hand))
   or (c.status='商品登録前' and c.channel='FBA' and c.shipped_on is null and not i.on_hand)
   or (c.status='出品中' and c.channel='FBA' and c.shipped_on is not null and i.bucket is not null);
 if bad <> 0 then raise exception 'Incorrect receipt or split shipment classification'; end if;
 if not exists (select 1 from app.v_deliverer_stock_workload_items detail
     join app.items i using(id)
     where i.asin='B0WORK2084' and i.product_id is null and detail.on_hand
       and detail.model_no='WORKLOAD-MODEL' and detail.title='X001E8Z9QH') then
   raise exception 'Legacy Amazon return model was not read from its ASIN';
 end if;
 select * into strict summary from app.v_deliverer_stock_workload where deliverer_id='99665000-0000-0000-0000-000000000002';
 if to_jsonb(summary) - 'deliverer_id' - 'deliverer_name' <> jsonb_build_object(
   'on_hand',0,'awaiting_receipt',0,'inspecting',0,'awaiting_registration',0,'listed_on_hand',0,
   'listed_in_fba',0,'trading_unshipped',0,'trading_shipped',0,'defective_on_hand',0,'amazon_returns',0
 ) then raise exception 'Historical assignee should have a row with all zero counts'; end if;
 if exists (select 1 from app.v_deliverer_stock_workload where deliverer_id='99665000-0000-0000-0000-000000000003')
 then raise exception 'Purchaser who has never handled deliveries should not appear'; end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.v_deliverer_workload)
   or exists(select 1 from app.v_deliverer_stock_workload)
   or exists(select 1 from app.v_deliverer_stock_workload_items)
   or exists(select 1 from workload_private.fba_stock_evidence)
 then raise exception 'Deliverer can read management workload'; end if;
end $$;
rollback;
