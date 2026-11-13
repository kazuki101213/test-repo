begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,marketplace_item_id,purchase_account_id)
select 992001,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'state action regression',1000,'ヤフオク','メルカリ','123456','x1200000001','auctions-2';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
select 992001,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'state action accessory',100,'ヤフオク',true;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare v_item uuid:=(select id from app.items where lot_seq=992001 and not is_accessory);request uuid:=gen_random_uuid();begin
 perform app.perform_inventory_action(v_item,'inspection_complete','検品中',null,request);
 perform app.perform_inventory_action(v_item,'inspection_complete','検品中',null,request);
 if (select count(*) from app.inventory_workflow_events where item_id=v_item)<>1 then raise exception 'Duplicate action was recorded';end if;
 begin perform app.perform_inventory_action(v_item,'inspection_complete','検品中');raise exception 'Stale action accepted';exception when serialization_failure then null;end;
 perform app.perform_inventory_action(v_item,'inspection_cancel','商品登録前');
 perform app.perform_inventory_action(v_item,'report','検品中','fault test');
 if exists(select 1 from app.items where lot_seq=992001 and status<>'動作不良') then raise exception 'Fault/accessory mismatch';end if;
 begin perform app.perform_inventory_action(v_item,'supplier_check','動作不良');raise exception 'Delivery manager action accepted';exception when insufficient_privilege then null;end;
 begin perform app.perform_inventory_action(v_item,'return_impossible','動作不良');raise exception 'Supplier check bypassed';exception when raise_exception then if sqlerrm='Supplier check bypassed' then raise;end if;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.items set malfunction_reported_at=now()-interval '1 second'
where lot_seq=992001 and not is_accessory;
insert into app.item_comments(item_id,author_id,body) select id,app.current_staff_id(),'ordinary reply keeps fault' from app.items where lot_seq=992001 and not is_accessory;
select app.send_malfunction_reply(gen_random_uuid(),id,'返送お願いしますか？',null)
from app.items where lot_seq=992001 and not is_accessory;
do $$begin
 if exists(select 1 from app.items where lot_seq=992001 and supplier_contact_requested_at is not null)
 then raise exception 'A question opened the supplier return workflow';end if;
end $$;
savepoint return_instruction;
select app.send_malfunction_reply(gen_random_uuid(),id,E'住所\n返送お願いします。\n着払いでお願いします。',null)
from app.items where lot_seq=992001 and not is_accessory;
do $$begin
 if not exists(select 1 from app.v_delivery_tasks where lot_seq=992001 and not is_accessory
   and supplier_contact_requested_at is not null and status='動作不良')
 then raise exception 'A return instruction did not enable the delivery return actions';end if;
end $$;
rollback to return_instruction;
do $$declare body text; v_item uuid:=(select id from app.items where lot_seq=992001 and not is_accessory);begin
 perform app.send_malfunction_reply(gen_random_uuid(),v_item,'着払いでお願いします。',null);
 if exists(select 1 from app.items where id=v_item and supplier_contact_requested_at is not null) then
  raise exception 'Unrelated cash-on-delivery reply enabled the return workflow';
 end if;
 foreach body in array array[
  E'【992001】【x1200000001】【DMR-2CX200】\n着払いでお願いします。',
  E'【992001】【x1200000001】【DMR-2CX200】\n返品くんで返品お願いします。'
 ] loop
  begin
   perform app.send_malfunction_reply(gen_random_uuid(),v_item,body,null);
   if not exists(select 1 from app.v_delivery_tasks where id=v_item and supplier_contact_requested_at is not null
    and status='動作不良' and sales_channel='メルカリ') then
    raise exception 'Return template changed sales or did not enable returns: %',body;
   end if;
   raise sqlstate 'P0002' using message='Roll back return template fixture';
  exception when no_data_found then null;
  end;
 end loop;
end $$;
select app.perform_inventory_action(id,'supplier_check',status) from app.items where lot_seq=992001 and not is_accessory;
do $$begin if exists(select 1 from app.items where lot_seq=992001 and status<>'動作不良') then raise exception 'Supplier check resolved report prematurely';end if;end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.complete_supplier_return(id,current_date,'1234-5678-9012',gen_random_uuid()) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'supplier_return_cancel',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'return_impossible',status) from app.items where lot_seq=992001 and not is_accessory;
do $$begin if exists(select 1 from app.items where lot_seq=992001 and (status<>'商品登録前' or sales_channel<>'ヤフオク')) then raise exception 'Yahoo instruction/accessory mismatch';end if;end $$;
select app.perform_inventory_action(id,'yahoo_instruction_cancel',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'report_cancel',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'inspection_complete',status) from app.items where lot_seq=992001 and not is_accessory;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.items set sales_channel='FBA' where lot_seq=992001 and not is_accessory;
set local role postgres;
insert into app.item_photos(item_id,storage_path) select id,'test/listing-992001.jpg' from app.items where lot_seq=992001 and not is_accessory;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at) select id,'fixture-folder',1,now() from app.items where lot_seq=992001 and not is_accessory;
update app.items set asin='B000TEST01',planned_price=1000,condition='非常に良い' where lot_seq=992001 and not is_accessory;
insert into app.amazon_listing_submissions(request_id,item_id,requested_by,sku,asin,sales_channel,account_id,seller_id,price,item_condition,description,work_completed_on,state,verified_at,note)
select gen_random_uuid(),i.id,(select user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),i.sku,i.asin,i.sales_channel,case when i.sales_channel::text in ('FBA2','自己発送2') then 'amazon-2' else 'amazon-1' end,case when i.sales_channel::text in ('FBA2','自己発送2') then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end,i.planned_price,i.condition::text,coalesce(i.description,''),current_date,'verified',clock_timestamp(),'test-first' from app.items i where lot_seq=992001 and not is_accessory;
set local role authenticated;

set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'listing_complete',status,null,(select request_id from app.amazon_listing_submissions where item_id=app.items.id)) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'listing_cancel',status,'confirmed not listed') from app.items where lot_seq=992001 and not is_accessory;
do $$begin
 begin perform app.set_inventory_workflow((select id from app.items where lot_seq=992001 and not is_accessory),'販売済');raise exception 'Delivery zero sale accepted';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.set_inventory_workflow(id,'販売済') from app.items where lot_seq=992001 and not is_accessory;
do $$begin
 begin perform app.perform_inventory_action((select id from app.items where lot_seq=992001 and not is_accessory),'inspection_cancel','商品登録前');raise exception 'Sold action accepted';exception when invalid_parameter_value then null;end;
end $$;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select 992002,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'Amazon action regression',0,'Amazon返品','FBA';
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'return_request_complete',status) from app.items where lot_seq=992002;
select app.perform_inventory_action(id,'return_request_cancel',status) from app.items where lot_seq=992002;
select app.perform_inventory_action(id,'return_request_complete',status) from app.items where lot_seq=992002;
select app.perform_inventory_action(id,'report',status,'damage report') from app.items where lot_seq=992002;
do $$declare v_item uuid:=(select id from app.items where lot_seq=992002);begin
 if (select status from app.items where items.id=v_item)<>'Amazon補填申請中' then raise exception 'Damage report went to wrong phase';end if;
 begin perform app.perform_inventory_action(v_item,'compensation_complete','Amazon補填申請中');raise exception 'Delivery compensation accepted';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.perform_inventory_action(id,'send_back',status,'再確認してください。') from app.items where lot_seq=992002;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'report',status,'damage report again') from app.items where lot_seq=992002;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.perform_inventory_action(id,'compensation_denied',status) from app.items where lot_seq=992002;
do $$begin if (select status from app.items where lot_seq=992002)<>'商品登録前' or (select sales_channel from app.items where lot_seq=992002)<>'ヤフオク' then raise exception 'Compensation result failed';end if;end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 begin perform app.perform_inventory_action((select id from app.items where lot_seq=992002),'inspection_cancel','商品登録前');raise exception 'Other deliverer accepted';exception when insufficient_privilege then null;end;
 if exists(select 1 from app.inventory_workflow_events e join app.items i on i.id=e.item_id where i.lot_seq in (992001,992002)) then raise exception 'Other deliverer saw action history';end if;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at)
select 992003,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'seller sync regression',1000,'ヤフオク','メルカリ','123456',now(),now();
do $$declare obs jsonb:=jsonb_build_object('external_id','m992003','serial','992003','status','取引中','trade_key','m992003:one','observed_at',now()+interval '1 second');item uuid:=(select id from app.items where lot_seq=992003);begin
 begin perform app.sync_seller_observation('flea-1',obs);raise exception 'Unsupported seller account accepted';exception when raise_exception then if sqlerrm='Unsupported seller account accepted' then raise;end if;end;
 if jsonb_array_length(app.seller_sync_context(array['mercari-1']))<>0 then raise exception 'Retired account received seller inventory';end if;
 if app.sync_seller_observation('mercari-2',obs)<>'updated' then raise exception 'Seller status not updated';end if;
 if app.sync_seller_observation('mercari-2',obs)<>'stale' then raise exception 'Stale seller status accepted';end if;
 perform app.perform_inventory_action(item,'trade_cancel','取引中','cancelled on site');
 if app.sync_seller_observation('mercari-2',obs||jsonb_build_object('observed_at',now()+interval '2 seconds'))<>'protected' then raise exception 'Cancelled trade reopened';end if;
 if app.sync_seller_observation('mercari-2',obs||jsonb_build_object('status','出品中','trade_key','m992003','observed_at',now()+interval '2 seconds'))<>'protected' then raise exception 'Listing placeholder cleared cancellation guard';end if;
 if app.sync_seller_observation('mercari-2',obs||jsonb_build_object('observed_at',now()+interval '2 seconds'))<>'protected' then raise exception 'Old trade reopened after listing observation';end if;
 if app.sync_seller_observation('mercari-2',obs||jsonb_build_object('trade_key','m992003:two','observed_at',now()+interval '3 seconds'))<>'updated' then raise exception 'New trade not attached to same inventory';end if;
 obs:=obs||jsonb_build_object('trade_key','m992003:two','status','販売済','sold_on',current_date-2,'sold_price',6100,'payout_amount',4371,'observed_at',now()+interval '4 seconds');
 if app.sync_seller_observation('mercari-2',obs)<>'registered' then raise exception 'Completed sale not saved';end if;
 if (select count(*) from app.items where lot_seq=992003)<>1 or not exists(select 1 from app.items where id=item and sold_on=current_date-2 and sold_price=6100 and payout_amount=4371 and status='販売済') then raise exception 'Duplicate inventory or wrong sale date/net';end if;
 if app.sync_seller_observation('mercari-2',obs||jsonb_build_object('status','出品中','observed_at',now()+interval '5 seconds'))<>'protected' then raise exception 'Sold item reopened';end if;
end $$;
rollback;
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,marketplace_item_id)
select 992004,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'queued operation regression',1000,'ヤフオク','メルカリ','123456',now(),'u992004';
set local role postgres;
insert into app.item_photos(item_id,storage_path) select id,'test/listing-992004.jpg' from app.items where lot_seq=992004 and not is_accessory;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at) select id,'fixture-folder',1,now() from app.items where lot_seq=992004 and not is_accessory;
set local role authenticated;
create temporary table op_probe(id uuid,payload jsonb,request uuid,source_request uuid);
insert into op_probe select id,jsonb_build_object('expected_revision',updated_at,'title','test','description','listing description','price',1000,'condition','目立った傷や汚れなし','origin','千葉県','shippingMethod','ゆうゆうメルカリ便','photos',jsonb_build_array('https://xgoppuqoqeppckyunnvx.supabase.co/storage/v1/object/sign/item-photos/test.jpg')),gen_random_uuid(),gen_random_uuid() from app.items where lot_seq=992004;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.queue_seller_operation(id,'listing',payload,request) from op_probe;
select app.queue_seller_operation(id,'listing',payload,request) from op_probe;
do $$declare p op_probe;begin select * into p from op_probe;
 if jsonb_array_length(app.seller_operation_context(p.id)->'operations')<>1 then raise exception 'Listing request duplicated';end if;
 begin perform app.extension_claim_seller_operation(p.request,'mercari-2');raise exception 'Delivery worker claim accepted';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare p op_probe;begin select * into p from op_probe;
 if (select account_id from app.seller_operations where id=p.request)<>'mercari-2' then raise exception 'Listing queued to the wrong Mercari account';end if;
 if app.extension_claim_seller_operation(p.request,'mercari-1') then raise exception 'Wrong Mercari profile claimed a listing';end if;
 if not app.extension_claim_seller_operation(p.request,'mercari-2') then raise exception 'Worker did not claim queued listing';end if;
 if app.extension_claim_seller_operation(p.request,'mercari-2') then raise exception 'Listing claimed twice';end if;
 perform app.extension_finish_seller_operation(p.request,'failed','{"note":"fixture never contacts a marketplace"}');
end $$;
select app.perform_inventory_action(id,'inspection_cancel','商品登録前') from op_probe;
select app.perform_inventory_action(id,'report','検品中','supplier test') from op_probe;
select app.perform_inventory_action(id,'supplier_check','動作不良') from op_probe;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.queue_supplier_operation(id,'read',null,'auctions-1',source_request) from op_probe;
select app.queue_supplier_operation(id,'read',null,'auctions-1',source_request) from op_probe;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare p op_probe;begin select * into p from op_probe;
 if not app.extension_claim_supplier_operation(p.source_request,'auctions-1') then raise exception 'Supplier request was not claimed';end if;
 if app.extension_claim_supplier_operation(p.source_request,'auctions-1') then raise exception 'Supplier request claimed twice';end if;
 perform app.extension_finish_supplier_operation(p.source_request,'succeeded',jsonb_build_array(jsonb_build_object('external_id','supplier-message-one','author','supplier','author_role','other','body','return is possible','sent_at',now())),'read without sending first');
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p op_probe;begin select * into p from op_probe;
 if jsonb_array_length(app.supplier_conversation(p.id)->'messages')<>1 then raise exception 'Supplier message hidden before first app send';end if;
 if app.read_supplier_operation(p.source_request)->>'status'<>'succeeded' then raise exception 'Small supplier status read failed';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$declare p op_probe;begin select * into p from op_probe;
 begin perform app.supplier_conversation(p.id);raise exception 'Other deliverer read supplier messages';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare v_today date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;begin
 -- The scheduler reports a Japan calendar day even when the CI server is on UTC.
 if app.extension_seller_daily_barrier(v_today,'88888888-0000-4000-8000-000000000001',array['mercari-1','mercari-2']) then raise exception 'Daily barrier opened early';end if;
 if not app.extension_seller_daily_barrier(v_today,'88888888-0000-4000-8000-000000000002',array['auctions-1','auctions-2','flea-1','flea-2','rakuma-1']) then raise exception 'Daily barrier did not open after seven';end if;
end $$;
rollback;
