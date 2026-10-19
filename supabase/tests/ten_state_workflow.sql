begin;
create temporary table workflow_probe as select * from app.items with no data;
alter table workflow_probe add column probe_id integer;
create trigger workflow_probe_status before insert or update on workflow_probe for each row execute function app.items_sync_status();
insert into workflow_probe(probe_id,marketplace,cost_amount,status,tracking_no,inspected_at,product_registered_at,malfunction_reported,malfunction_resolved_at,sales_channel) values
(1,'ヤフオク',100,'受取前',null,null,null,false,null,'メルカリ'),
(2,'ヤフオク',100,'受取前','123',null,null,false,null,'FBA'),
(3,'Amazon返品',100,'受取前','X123',null,null,false,null,'FBA'),
(4,'動作品Amazon返品',100,'受取前',null,null,null,false,null,'メルカリ'),
(5,'ヤフオク',100,'受取前','123',now(),null,false,null,'メルカリ'),
(6,'ヤフオク',100,'受取前','123',now(),now(),false,null,'FBA'),
(7,'ヤフオク',100,'受取前','123',null,null,true,null,'ヤフオク');
do $$begin
if (select array_agg(status::text order by probe_id) from workflow_probe)<>array['受取前','検品中','Amazon返送依頼','Amazon返送依頼','商品登録前','出品中','動作不良'] then raise exception 'Initial classification failed';end if;
end $$;
update workflow_probe set status='検品中' where probe_id=3;
update workflow_probe set status='取引中' where probe_id=5;
update workflow_probe set photo_uploaded_at=now(),shipped_on=current_date where probe_id=5;
update workflow_probe set status='Amazon補填申請中' where probe_id=4;
update workflow_probe set packed_on=current_date where probe_id=4;
do $$begin
if (select status from workflow_probe where probe_id=3)<>'検品中' or (select return_request_completed_at from workflow_probe where probe_id=3) is null then raise exception 'Return request transition failed';end if;
if (select status from workflow_probe where probe_id=5)<>'取引中' then raise exception 'Transaction overwritten by photo/shipping';end if;
if (select status from workflow_probe where probe_id=4)<>'Amazon補填申請中' then raise exception 'Compensation overwritten by packing';end if;
end $$;
update workflow_probe set status='商品登録前' where probe_id=4;
update workflow_probe set status='販売済' where probe_id=5;
update workflow_probe set status='出品中' where probe_id=5;
update workflow_probe set shipped_on=current_date where probe_id=1;
do $$begin
if (select status from workflow_probe where probe_id=1)<>'受取前' then raise exception 'Shipping still changes status';end if;
if (select status from workflow_probe where probe_id=4)<>'商品登録前' then raise exception 'Compensation exit failed';end if;
if not exists(select 1 from workflow_probe where probe_id=5 and status='販売済' and sold_on=(now() at time zone 'Asia/Tokyo')::date and sold_price=0 and payout_amount=0) then raise exception 'Explicit zero sale or protection failed';end if;
if enum_range(null::app.item_status)::text[]<>array['受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','出品中','取引中','販売済','返品処理','動作不良'] then raise exception 'Ten states/order mismatch';end if;
if pg_get_viewdef('app.v_delivery_tasks'::regclass,true) like '%ARRAY[%item_status%' then raise exception 'Legacy delivery whitelist remains';end if;
end $$;
rollback;

-- Exercise the actual RLS/RPC/parent-accessory path in a rolled-back fixture.
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select 990091,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'workflow regression',1000,'ヤフオク','メルカリ','123456';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
select 990091,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'accessory regression',100,'ヤフオク',true;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.report_item_malfunction((select id from app.items where lot_seq=990091 and not is_accessory),'mistaken report');
do $$begin
if exists(select 1 from app.items where lot_seq=990091 and status<>'動作不良') then raise exception 'Malfunction/accessory synchronization failed';end if;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin
 begin perform app.resolve_item_malfunction((select id from app.items where lot_seq=990091 and not is_accessory));raise exception 'Legacy return without reason accepted';exception when invalid_parameter_value then null;end;
end $$;
select app.perform_inventory_action(id,'send_back',status,'動作を再確認してください。') from app.items where lot_seq=990091 and not is_accessory;
do $$begin
if exists(select 1 from app.items where lot_seq=990091 and status<>'検品中') then raise exception 'Mistaken report return failed';end if;
if app.sync_marketplace_sale_status('メルカリ','990091','出品中',clock_timestamp())<>'updated' then raise exception 'Seller list update failed';end if;
if app.sync_marketplace_sale_status('メルカリ','990091','取引中',now()-interval '1 minute')<>'stale' then raise exception 'Stale snapshot accepted';end if;
end $$;
select app.set_inventory_workflow((select id from app.items where lot_seq=990091 and not is_accessory),'取引中');
select app.set_inventory_workflow((select id from app.items where lot_seq=990091 and not is_accessory),'販売済');
do $$begin
if exists(select 1 from app.items where lot_seq=990091 and (status<>'販売済' or sold_on<>(now() at time zone 'Asia/Tokyo')::date or sold_price<>0 or payout_amount<>0)) then raise exception 'Zero sale/accessory values mismatch';end if;
if app.sync_marketplace_sale_status('メルカリ','990091','出品中',clock_timestamp())<>'protected' then raise exception 'Sold item reopened';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
begin
 perform app.set_inventory_workflow((select id from app.items where lot_seq=990091 and not is_accessory),'検品中');
 raise exception 'Unauthorized workflow transition accepted';
exception when insufficient_privilege then null;end;
end $$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select 990092,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'origin non-sale',1000,'ヤフオク','メルカリ';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select '990092c-AADD-'||to_char(current_date,'YYYYMMDD')||'-100',990092,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'standalone C',1000,'ヤフオク','メルカリ';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select '990092b-AADD-'||to_char(current_date,'YYYYMMDD')||'-0',990092,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'working return',0,'動作品Amazon返品','メルカリ';
do $$begin
if not exists(select 1 from app.items where title='origin non-sale' and sold_on is not null and status='販売済' and sold_price=0 and payout_amount=0 and cost_amount=1000) then raise exception 'Non-sale predecessor was not closed with its cost preserved';end if;
if exists(select 1 from app.items where title='standalone C' and sold_on is not null) then raise exception 'Standalone C was closed with another family';end if;
end $$;
rollback;
