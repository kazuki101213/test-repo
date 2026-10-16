begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select 992001,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'state action regression',1000,'ヤフオク','メルカリ','123456';
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
insert into app.item_comments(item_id,author_id,body) select id,app.current_staff_id(),'ordinary reply keeps fault' from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'supplier_check',status) from app.items where lot_seq=992001 and not is_accessory;
do $$begin if exists(select 1 from app.items where lot_seq=992001 and status<>'動作不良') then raise exception 'Supplier check resolved report prematurely';end if;end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'supplier_return_complete',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'supplier_return_cancel',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'return_impossible',status) from app.items where lot_seq=992001 and not is_accessory;
do $$begin if exists(select 1 from app.items where lot_seq=992001 and (status<>'商品登録前' or sales_channel<>'ヤフオク')) then raise exception 'Yahoo instruction/accessory mismatch';end if;end $$;
select app.perform_inventory_action(id,'yahoo_instruction_cancel',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'report_cancel',status) from app.items where lot_seq=992001 and not is_accessory;
select app.perform_inventory_action(id,'inspection_complete',status) from app.items where lot_seq=992001 and not is_accessory;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.items set sales_channel='FBA' where lot_seq=992001 and not is_accessory;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'listing_complete',status) from app.items where lot_seq=992001 and not is_accessory;
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
select app.perform_inventory_action(id,'send_back',status) from app.items where lot_seq=992002;
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
 if app.sync_seller_observation('mercari-1',obs)<>'updated' then raise exception 'Seller status not updated';end if;
 if app.sync_seller_observation('mercari-1',obs)<>'stale' then raise exception 'Stale seller status accepted';end if;
 perform app.perform_inventory_action(item,'trade_cancel','取引中','cancelled on site');
 if app.sync_seller_observation('mercari-1',obs||jsonb_build_object('observed_at',now()+interval '2 seconds'))<>'protected' then raise exception 'Cancelled trade reopened';end if;
 if app.sync_seller_observation('mercari-1',obs||jsonb_build_object('trade_key','m992003:two','observed_at',now()+interval '3 seconds'))<>'updated' then raise exception 'New trade not attached to same inventory';end if;
 obs:=obs||jsonb_build_object('trade_key','m992003:two','status','販売済','sold_on',current_date-2,'sold_price',6100,'payout_amount',4371,'observed_at',now()+interval '4 seconds');
 if app.sync_seller_observation('mercari-1',obs)<>'updated' then raise exception 'Completed sale not saved';end if;
 if (select count(*) from app.items where lot_seq=992003)<>1 or not exists(select 1 from app.items where id=item and sold_on=current_date-2 and sold_price=6100 and payout_amount=4371 and status='販売済') then raise exception 'Duplicate inventory or wrong sale date/net';end if;
 if app.sync_seller_observation('mercari-1',obs||jsonb_build_object('status','出品中','observed_at',now()+interval '5 seconds'))<>'protected' then raise exception 'Sold item reopened';end if;
end $$;
rollback;
