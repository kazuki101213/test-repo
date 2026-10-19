\set ON_ERROR_STOP on
-- Disposable CI fixtures only. No production transactions or external actions.
begin;
insert into app.staff(id,code,name,role) values('99665000-0000-0000-0000-000000000001','QW','workload metric fixture','deliverer');
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
insert into app.items(id,lot_seq,sku,purchaser_id,deliverer_id,title,cost_amount,marketplace,sales_channel,tracking_no,is_accessory)
select id,996650+n,(996650+n)::text||case when is_accessory then 'c' else '' end||'-AAQW-20261019-100',(select id from app.staff where code='AA'),'99665000-0000-0000-0000-000000000001','workload metric fixture',100,'ヤフオク',channel,case when status='受取前' then null else 'tracking' end,is_accessory from workload_cases;
update app.items i set status=c.status,shipped_on=c.shipped_on from workload_cases c where i.id=c.id;
do $$begin if exists(select 1 from app.items i join workload_cases c using(id) where i.status<>c.status) then raise exception 'Fixture status changed by workflow validation';end if;end $$;

grant select on workload_cases to authenticated;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$ declare actual record;begin
 select * into actual from app.v_deliverer_workload where deliverer_id='99665000-0000-0000-0000-000000000001';
 if not found then raise exception 'Workload fixture missing';end if;
 if actual."保有在庫"<>(select count(*) from workload_cases where expected_held) then raise exception 'Held count mismatch: %',actual."保有在庫";end if;
 if actual."作業在庫"<>(select count(*) from workload_cases where expected_working) then raise exception 'Working count mismatch: %',actual."作業在庫";end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin if exists(select 1 from app.v_deliverer_workload) then raise exception 'Deliverer can read management workload';end if;end $$;
rollback;
