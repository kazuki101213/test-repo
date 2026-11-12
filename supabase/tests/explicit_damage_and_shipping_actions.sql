begin;
insert into app.items(id,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
select '99899200-0000-4000-8000-000000000001',998992,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'explicit damage fixture',1000,'ヤフオク','ヤフオク','fixture','検品中';
set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 begin
  perform app.report_item_with_damage('99899200-0000-4000-8000-000000000001','検品中','別担当','99899200-0000-4000-8000-000000000002','{}',true);
  raise exception 'Other assignee changed report';
 exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.report_item_with_damage('99899200-0000-4000-8000-000000000001','検品中','本体に割れがあります。','99899200-0000-4000-8000-000000000002','{}',true);
select app.report_item_with_damage('99899200-0000-4000-8000-000000000001','検品中','本体に割れがあります。','99899200-0000-4000-8000-000000000002','{}',true);
do $$begin
 if (select has_physical_damage from app.v_delivery_tasks where lot_seq=998992) is not true then raise exception 'Explicit checkbox missing from detail';end if;
 if (select count(*) from app.inventory_workflow_events where item_id='99899200-0000-4000-8000-000000000001')<>1 then raise exception 'Report replay duplicated';end if;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.perform_inventory_action('99899200-0000-4000-8000-000000000001','send_back','動作不良','再確認');
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.report_item_with_damage('99899200-0000-4000-8000-000000000001','検品中','録画不可。','99899200-0000-4000-8000-000000000003','{}',false);
do $$begin
 if (select has_physical_damage from app.items where lot_seq=998992) then raise exception 'New unchecked report inherited damage';end if;
end $$;
set local role postgres;
-- No live marketplace is contacted. These are disposable proof/queue fixtures.
insert into app.items(id,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
select '99899300-0000-4000-8000-000000000001',998993,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'shipping confirmation fixture',1000,'ヤフオク','メルカリ','fixture','取引中';
update app.items set inspected_at=now(),product_registered_at=now(),seller_trade_key='m998993:current',status='取引中' where lot_seq=998993;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
values('99899300-0000-4000-8000-000000000001','メルカリ','mercari-1','m998993','https://jp.mercari.com/item/m998993','m998993:current');
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result)
select '99899300-0000-4000-8000-000000000002',id,deliverer_id,'shipping_code','メルカリ','mercari-1',status,updated_at,'{"trade_key":"m998993:current","size":"100","dropoff":"セブンイレブン"}','succeeded','{"qr_code":"fixture"}' from app.items where lot_seq=998993;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
savepoint manual_code_fixture;
do $$declare item_id uuid:='99899300-0000-4000-8000-000000000001'; payload jsonb; request_id uuid:=gen_random_uuid(); bad jsonb;begin
 select jsonb_build_object('trade_key','m998993:current','expected_revision',updated_at,'shippingMethod','らくらくメルカリ便',
  'size','100','dropoff','セブンイレブン') into payload from app.items where id=item_id;
 foreach bad in array array[payload-'size',payload||'{"dropoff":"郵便局"}',payload||'{"automatic_line":true}'] loop
  begin
   perform app.queue_seller_operation(item_id,'shipping_code',bad,gen_random_uuid());
   raise exception 'Invalid manual or automatic code request was accepted';
  exception when invalid_parameter_value then null;end;
 end loop;
 if app.queue_seller_operation(item_id,'shipping_code',payload,request_id) is distinct from request_id then
  raise exception 'Valid manual shipping choice was rejected';
 end if;
 if app.queue_seller_operation(item_id,'shipping_code',payload,request_id) is distinct from request_id then
  raise exception 'Manual shipping replay did not return its original request';
 end if;
 begin
  perform app.extension_claim_seller_operation(request_id,'mercari-1');
  raise exception 'A deliverer claimed an extension operation';
 exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
 if app.extension_claim_seller_operation(request_id,'mercari-2') is distinct from false
   or app.extension_claim_seller_operation(request_id,'mercari-1') is distinct from true then
  raise exception 'The correct account could not claim the validated manual code request';
 end if;
 if app.extension_claim_seller_operation(request_id,'mercari-1') is distinct from false then
  raise exception 'The same shipping operation was claimed twice';
 end if;
end $$;
rollback to manual_code_fixture;
savepoint stale_trade_fixture;
select app.queue_seller_operation(id,'shipping_code',
  jsonb_build_object('trade_key','m998993:current','expected_revision',updated_at,'shippingMethod','らくらくメルカリ便',
    'size','100','dropoff','セブンイレブン'),'99899300-0000-4000-8000-000000000003')
from app.items where lot_seq=998993;
reset role;
update app.seller_listings set trade_key='m998993:changed' where external_id='m998993';
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin
 if app.extension_claim_seller_operation('99899300-0000-4000-8000-000000000003','mercari-1') is distinct from false then
  raise exception 'A stale trade shipping request was claimed';
 end if;
 if has_function_privilege('authenticated','app.seller_shipping_validation_error(uuid,text,text,jsonb)','execute')
   or has_function_privilege('anon','app.seller_shipping_validation_error(uuid,text,text,jsonb)','execute') then
  raise exception 'Internal shipping validation is exposed';
 end if;
end $$;
rollback to stale_trade_fixture;
do $$declare payload jsonb;begin
 select jsonb_build_object('trade_key','m998993:current','proof_id','99899300-0000-4000-8000-000000000002','expected_revision',updated_at,'posted',false) into payload from app.items where lot_seq=998993;
 begin
  perform app.queue_seller_operation('99899300-0000-4000-8000-000000000001','ship_notice',payload,gen_random_uuid());
  raise exception 'Shipment notification accepted without user confirmation';
 exception when raise_exception then if SQLERRM='Shipment notification accepted without user confirmation' then raise;end if;end;
 perform app.queue_seller_operation('99899300-0000-4000-8000-000000000001','ship_notice',payload||'{"posted":true}',gen_random_uuid());
 if (select count(*) from app.seller_operations where item_id='99899300-0000-4000-8000-000000000001' and kind='ship_notice')<>1 then raise exception 'Explicit shipping confirmation not queued once';end if;
end $$;
rollback;
