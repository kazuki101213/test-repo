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
