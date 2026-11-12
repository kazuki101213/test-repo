-- Disposable CI data only. These operations never contact a marketplace.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'work completion fixture',1000,'ヤフオク',case n when 998301 then 'FBA'::app.sales_channel when 998302 then '自己発送'::app.sales_channel when 998304 then 'ヤフオク'::app.sales_channel else 'メルカリ'::app.sales_channel end,'fixture',now() from generate_series(998301,998308) n;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
select 998301,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'work completion linked accessory',100,'ヤフオク',true;
insert into app.item_photos(item_id,storage_path) select id,'test/work-'||lot_seq||'.jpg' from app.items where lot_seq between 998301 and 998304 and not is_accessory;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at) select id,'fixture',1,now() from app.items where lot_seq between 998301 and 998304 and not is_accessory;
update app.items set status='動作不良',supplier_contact_requested_at=clock_timestamp() where lot_seq in (998305,998306);
update app.items set marketplace_item_id='x1200000002',purchase_account_id='auctions-2' where lot_seq=998305;
update app.items set status='Amazon補填申請中',malfunction_reported=true,malfunction_reported_at=clock_timestamp() where lot_seq in (998307,998308);
insert into app.delivery_invoice_profiles(staff_id,details,unit_price,enabled) select id,'{}',1000,true from app.staff where code='DD'
on conflict(staff_id) do update set unit_price=1000,enabled=true;
create temporary table work_probe as select id,lot_seq from app.items where lot_seq between 998301 and 998308 and not is_accessory;
grant select on work_probe to authenticated;
update app.items set asin='B000TEST01',planned_price=1000,condition='非常に良い' where lot_seq in (998301,998302) and not is_accessory;
do $$begin
 if exists(select 1 from app.items where lot_seq between 998301 and 998308 and packed_on is not null) then raise exception 'Inspection/reports registered a work date';end if;
end $$;
insert into app.amazon_listing_submissions(request_id,item_id,requested_by,sku,asin,sales_channel,account_id,seller_id,price,item_condition,description,work_completed_on,state,verified_at,note)
select gen_random_uuid(),i.id,(select user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),i.sku,i.asin,i.sales_channel,case when i.sales_channel::text in ('FBA2','自己発送2') then 'amazon-2' else 'amazon-1' end,case when i.sales_channel::text in ('FBA2','自己発送2') then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end,i.planned_price,i.condition::text,coalesce(i.description,''),current_date-2,'verified',clock_timestamp(),'test-first' from app.items i where lot_seq in (998301,998302) and not is_accessory;
insert into app.amazon_listing_submissions(request_id,item_id,requested_by,sku,asin,sales_channel,account_id,seller_id,price,item_condition,description,work_completed_on,state,verified_at,note)
select gen_random_uuid(),i.id,(select user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),i.sku,i.asin,i.sales_channel,case when i.sales_channel::text in ('FBA2','自己発送2') then 'amazon-2' else 'amazon-1' end,case when i.sales_channel::text in ('FBA2','自己発送2') then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end,i.planned_price,i.condition::text,coalesce(i.description,''),current_date,'verified',clock_timestamp(),'test-second' from app.items i where lot_seq in (998301,998302) and not is_accessory;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare i uuid;r uuid;d date:=current_date-2;begin
 if not exists(select 1 from app.items where lot_seq=998301 and not is_accessory and status='商品登録前' and packed_on=d and shipped_on is null) then raise exception 'FBA receipt did not record work before listing completion';end if;
 for i in select id from work_probe where lot_seq in (998301,998302) loop
  r:=(select request_id from app.amazon_listing_submissions where item_id=i and note='test-first');perform app.perform_dated_inventory_action(i,'listing_complete','商品登録前',d,r);
  perform app.perform_dated_inventory_action(i,'listing_complete','商品登録前',d,r);
  if (select packed_on from app.items where id=i) is distinct from d then raise exception 'FBA/self date not atomic';end if;
  if (select count(*) from app.inventory_workflow_events where id=r)<>1 then raise exception 'Duplicate listing action';end if;
  perform app.perform_inventory_action(i,'listing_cancel','出品中','CI fixture only');
  perform app.perform_dated_inventory_action(i,'listing_complete','商品登録前',current_date,(select request_id from app.amazon_listing_submissions where item_id=i and note='test-second'));
  if (select packed_on from app.items where id=i) is distinct from d then raise exception 'Relisting overwrote first date';end if;
 end loop;
 if (select packed_on from app.items where lot_seq=998301 and is_accessory) is distinct from d then raise exception 'Linked accessory date not shared';end if;
 i:=(select id from work_probe where lot_seq=998305);
 begin
  perform app.complete_supplier_return(i,d,'   ',gen_random_uuid());
  raise exception 'Return accepted without a tracking number';
 exception when invalid_parameter_value then null; end;
 r:=gen_random_uuid();
 perform app.complete_supplier_return(i,d,' 1234-5678-9012 ',r);
 perform app.complete_supplier_return(i,d,'1234-5678-9012',r);
 if not exists(select 1 from app.items where id=i and status='返品処理' and packed_on=d
    and return_tracking_no='1234-5678-9012' and tracking_no='fixture')
 then raise exception 'Return date and tracking number were not saved together';end if;
 if not exists(select 1 from app.v_delivery_tasks where id=i and return_tracking_no='1234-5678-9012')
 then raise exception 'Return tracking number is missing from the delivery card';end if;
 if (select count(*) from jsonb_array_elements(app.supplier_conversation(i)->'outbox')
     where value->>'id'=r::text and value->>'status'='queued' and strpos(value->>'body','追跡番号：1234-5678-9012')>0)<>1
 then raise exception 'The return did not queue exactly one tracking message';end if;
 perform app.perform_inventory_action(i,'supplier_return_cancel','返品処理');
 if exists(select 1 from app.items where id=i and return_tracking_no is not null) then raise exception 'Cancelled return kept tracking number';end if;
 if (app.read_supplier_operation(r)->>'status') is distinct from 'failed' then raise exception 'Cancelled return can still send';end if;
 perform app.complete_supplier_return(i,current_date,'9012-5678-1234',gen_random_uuid());
 if (select packed_on from app.items where id=i) is distinct from d then raise exception 'Repeated return overwrote work date';end if;
 i:=(select id from work_probe where lot_seq=998306);
 begin perform app.complete_delivery_work(i,(clock_timestamp() at time zone 'Asia/Tokyo')::date+1);raise exception 'Future date accepted';exception when invalid_parameter_value then null;end;
 begin perform app.complete_delivery_work(i,current_date-11);raise exception 'Pre-purchase date accepted';exception when invalid_parameter_value then null;end;
 perform app.complete_delivery_work(i,d);perform app.complete_delivery_work(i,d);
 if not exists(select 1 from app.items where id=i and status='動作不良' and packed_on=d) then raise exception 'Manual completion changed status';end if;
 if (select count(*) from app.inventory_workflow_events where item_id=i and action='work_complete')<>1 then raise exception 'Manual completion duplicated';end if;
 begin perform app.complete_delivery_work(i,current_date);raise exception 'Existing date overwritten';exception when serialization_failure then null;end;
 i:=(select id from work_probe where lot_seq=998307);
 begin perform app.complete_compensation_report(i,(select malfunction_reported_at from app.items where id=i));raise exception 'Deliverer acknowledged admin report';exception when insufficient_privilege then null;end;
 perform app.complete_delivery_work(i,d);
 r:=gen_random_uuid();perform app.complete_delivery_compensation(i,r);perform app.complete_delivery_compensation(i,r);
 if not exists(select 1 from app.items where id=i and status='商品登録前' and sales_channel='ヤフオク' and packed_on=d) then raise exception 'Assignee compensation transition changed work date';end if;
end $$;
-- External listings retain the selected date while queued/failed/uncertain without billing it yet.
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare i app.items;op uuid;payload jsonb;begin
 for i in select * from app.items where lot_seq in (998303,998304) loop
  payload:=jsonb_build_object('expected_revision',i.updated_at,'title','CI fixture','description','CI fixture','price',1000,'condition','可','origin','千葉県','shippingMethod','ゆうゆうメルカリ便','photos',jsonb_build_array('https://xgoppuqoqeppckyunnvx.supabase.co/storage/v1/object/sign/item-photos/test.jpg'),'work_completed_on',current_date-3);
  op:=app.queue_seller_operation(i.id,'listing',payload,gen_random_uuid());
  if (select packed_on from app.items where id=i.id) is not null then raise exception 'Queued listing billed early';end if;
  if not app.extension_claim_seller_operation(op,case when i.sales_channel='メルカリ' then 'mercari-2' else 'auctions-1' end) then raise exception 'Listing not claimed';end if;
  if i.lot_seq=998303 then
   perform app.extension_finish_seller_operation(op,'failed','{"note":"CI fixture failure"}');
   if (select packed_on from app.items where id=i.id) is not null then raise exception 'Failed listing billed';end if;
   op:=app.queue_seller_operation(i.id,'listing',payload,gen_random_uuid());
   perform app.extension_claim_seller_operation(op,'mercari-2');
   perform app.extension_finish_seller_operation(op,'uncertain','{"note":"CI fixture uncertain"}');
   if (select packed_on from app.items where id=i.id) is not null then raise exception 'Uncertain listing billed';end if;
   perform app.request_listing_result_check(i.id,'https://jp.mercari.com/item/m998303');
   perform app.extension_claim_listing_result_check(op,'mercari-2');
   perform app.extension_finish_listing_result_check(op,jsonb_build_object('external_id','m998303','url','https://jp.mercari.com/item/m998303','observed_at',clock_timestamp()));
  else
   perform app.extension_finish_seller_operation(op,'succeeded','{"external_id":"r998304","url":"https://page.auctions.yahoo.co.jp/jp/auction/r998304"}');
  end if;
  if not exists(select 1 from app.items where id=i.id and status='出品中' and packed_on=current_date-3 and packed_completed_at is not null) then raise exception 'Confirmed external listing did not preserve selected date';end if;
 end loop;
end $$;
set local role postgres;
update app.items set sold_on=current_date where lot_seq=998303;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare i uuid:=(select id from work_probe where lot_seq=998308);reported timestamptz;data jsonb;begin
 select malfunction_reported_at into reported from app.items where id=i;
 perform app.complete_compensation_report(i,reported);perform app.complete_compensation_report(i,reported);
 data:=app.read_resource_snapshot('malfunctions');
 if exists(select 1 from jsonb_array_elements(data->'rows') r where r->>'id'=i::text) then raise exception 'Acknowledged report still visible';end if;
 if not exists(select 1 from app.items where id=i and status='Amazon補填申請中' and packed_on is null and sales_channel='メルカリ') then raise exception 'Acknowledgment moved inventory or billed work';end if;
 update app.items set malfunction_reported_at=reported+interval '1 second' where id=i;
 data:=app.read_resource_snapshot('malfunctions');
 if not exists(select 1 from jsonb_array_elements(data->'rows') r where r->>'id'=i::text) then raise exception 'Fresh report hidden by old acknowledgment';end if;
 begin perform app.complete_compensation_report(i,reported);raise exception 'Stale acknowledgment accepted';exception when serialization_failure then null;end;
end $$;
-- Monthly invoice uses work date, not listing/return/sale status, and keeps exact serial deduplication.
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare inv jsonb;i record;begin
 for i in select * from app.items where lot_seq between 998301 and 998307 and not is_accessory loop
  inv:=app.prepare_delivery_invoice(i.deliverer_id,date_trunc('month',i.packed_on)::date);
  if (select count(*) from jsonb_array_elements(inv->'lines') l where l->>'item_id'=i.id::text)<>1 then raise exception 'Completed work missing/duplicated in invoice for %',i.lot_seq;end if;
 end loop;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$declare i uuid:=(select id from work_probe where lot_seq=998308);begin
 begin perform app.complete_delivery_work(i,current_date);raise exception 'Other assignee completed work';exception when insufficient_privilege then null;end;
 begin perform app.complete_delivery_compensation(i,gen_random_uuid());raise exception 'Other assignee completed compensation';exception when insufficient_privilege then null;end;
 begin perform app.perform_dated_inventory_action(i,'listing_complete','商品登録前',current_date,gen_random_uuid());raise exception 'Other assignee dated action accepted';exception when insufficient_privilege then null;end;
 if has_function_privilege('anon','app.complete_delivery_work(uuid,date)','EXECUTE') or has_function_privilege('anon','app.complete_compensation_report(uuid,timestamp with time zone)','EXECUTE') then raise exception 'Anonymous access granted';end if;
end $$;
set local role postgres;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,
  marketplace_item_id,purchase_account_id,sales_channel,status,malfunction_reported,supplier_contact_requested_at)
select fixture.lot_seq,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
  current_date-5,'return notice test',1000,'メルカリ',fixture.item_id,fixture.account_id,'ヤフオク','動作不良',true,now()
from (values (998309,'m12000000001','mercari-1'),(998310,'m12000000002',null)) fixture(lot_seq,item_id,account_id);
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$
declare
  mercari_item uuid:=(select id from app.items where lot_seq=998309);
  unknown_item uuid:=(select id from app.items where lot_seq=998310);
begin
  begin
    perform app.complete_supplier_return(unknown_item,current_date,'123456789012',gen_random_uuid());
    raise exception 'Unverified purchase account accepted';
  exception when invalid_parameter_value then null; end;
  if (select status from app.items where id=unknown_item)<>'動作不良' then
    raise exception 'Unroutable return changed status';
  end if;
  perform app.complete_supplier_return(mercari_item,current_date,'123456789012',gen_random_uuid());
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare
  mercari_item uuid:=(select id from app.items where lot_seq=998309);
  yahoo_item uuid:=(select id from work_probe where lot_seq=998305);
  notice jsonb;
begin
  select value into notice from jsonb_array_elements(app.extension_supplier_queue(array['auctions-2']))
    where value->>'item_id'=yahoo_item::text;
  if notice is null or notice->>'external_id'<>'x1200000002' then raise exception 'Yahoo return purchase route missing'; end if;
  if not app.extension_claim_supplier_operation((notice->>'id')::uuid,'auctions-2') then
    raise exception 'Yahoo return could not be claimed after completion';
  end if;
  select value into notice from jsonb_array_elements(app.extension_supplier_queue(array['mercari-1']))
    where value->>'item_id'=mercari_item::text;
  if notice is null or notice->>'external_id'<>'m12000000001' or notice->>'kind'<>'send' then
    raise exception 'Mercari return purchase route missing';
  end if;
  if app.extension_claim_supplier_operation((notice->>'id')::uuid,'mercari-2') or
    not app.extension_claim_supplier_operation((notice->>'id')::uuid,'mercari-1') then
    raise exception 'Mercari return account claim failed';
  end if;
  perform app.extension_finish_supplier_operation((notice->>'id')::uuid,'succeeded','[]'::jsonb,'Test only');
  perform app.perform_inventory_action(mercari_item,'supplier_return_cancel','返品処理');
  perform app.complete_supplier_return(mercari_item,current_date,'123456789012',gen_random_uuid());
  if exists(select 1 from jsonb_array_elements(app.extension_supplier_queue(array['mercari-1']))
    where value->>'item_id'=mercari_item::text) then raise exception 'Already sent notice was queued again'; end if;
end $$;
rollback;
