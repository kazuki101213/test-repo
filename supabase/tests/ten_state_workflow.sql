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
