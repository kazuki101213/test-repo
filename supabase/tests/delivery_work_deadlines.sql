begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq, purchaser_id, deliverer_id, purchased_at, title, cost_amount, marketplace, sales_channel, tracking_no, inspected_at, cleaned_at)
select n, (select id from app.staff where code='AA'), (select id from app.staff where code='DD'),
  current_date, 'Work deadlines fixture', 1000, 'メルカリ',
  case when n=997591 then 'FBA2'::app.sales_channel else 'メルカリ'::app.sales_channel end,
  case when n=997590 then null else 'fixture-inserted' end,
  case when n=997590 then null else now() end, case when n=997590 then null else now() end
from unnest(array[997590,997591,997592]) n;

do $$declare target uuid; stamp timestamptz; begin
  select id into strict target from app.items where lot_seq=997590;
  if exists(select 1 from app.item_tracking_recordings where item_id=target) then raise exception 'Blank tracking starts a deadline'; end if;
  update app.items set tracking_no='fixture-new' where id=target;
  select recorded_at into strict stamp from app.item_tracking_recordings where item_id=target;
  update app.items set tracking_no='fixture-corrected', title='Fixture edited' where id=target;
  if stamp is distinct from (select recorded_at from app.item_tracking_recordings where item_id=target)
    then raise exception 'Corrected tracking resets the deadline'; end if;
end $$;

insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at,approved_at,approved_by)
select id,'work-deadline-fixture',1,now(),now(),purchaser_id from app.items where lot_seq=997592;
update app.items set status='商品登録前' where lot_seq in (997591,997592);

set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare payload jsonb; begin
  payload := app.read_resource_snapshot('delivery_work_tasks');
  if not exists(select 1 from jsonb_array_elements(payload->'rows') row
    where row->>'kind'='inspection' and row->>'lot_seq'='997590' and row->>'tracking_recorded_at' is not null)
    then raise exception 'Tracking does not open inspection'; end if;
  if not exists(select 1 from app.v_delivery_work_tasks where lot_seq=997591 and kind='listing_due')
    then raise exception 'Pending FBA listing deadline missing'; end if;
  if (select count(*) from app.v_delivery_work_tasks where lot_seq=997592 and kind in ('listing_due','photo_approved'))<>1
    or not exists(select 1 from app.v_delivery_work_tasks where lot_seq=997592 and kind='photo_approved' and tracking_recorded_at is not null)
    then raise exception 'Approved listing is duplicated or missing tracking time'; end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
  if exists(select 1 from app.v_delivery_work_tasks where lot_seq in (997590,997591,997592))
    then raise exception 'Other staff can see delivery work'; end if;
end $$;

set local role postgres;
update app.items set inspected_at=now() where lot_seq=997590;
with plan as (
  insert into app.fba_inbound_plans(account,staff_id,name,created_by,stage)
  select 'FBA2',deliverer_id,'Work deadlines fixture','11111111-1111-1111-1111-111111111111','ready'
  from app.items where lot_seq=997591 returning id
)
insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel)
select plan.id,i.id,i.sku,'B000000001',i.title,'良い',i.sales_channel from plan cross join app.items i where i.lot_seq=997591;

set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
  if exists(select 1 from app.v_delivery_work_tasks where lot_seq=997590 and kind='inspection')
    then raise exception 'Inspection still requested after it was recorded'; end if;
  if exists(select 1 from app.v_delivery_work_tasks where lot_seq=997591 and kind='listing_due')
    then raise exception 'Confirmed FBA inbound still requested'; end if;
end $$;
rollback;
