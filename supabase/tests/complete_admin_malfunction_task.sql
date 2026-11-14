-- Disposable database. Management task completion has no effect on inventory workflow.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select 997863,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
       current_date,'Management completion fixture',1000,'ヤフオク','FBA2','fixture',now();
update app.items
set status='動作不良',malfunction_reported=true,malfunction_reported_at=clock_timestamp()-interval '1 minute'
where lot_seq=997863;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$
declare item app.items;
begin
  select * into item from app.items where lot_seq=997863;
  begin
    perform app.complete_malfunction_task(item.id,item.malfunction_reported_at);
    raise exception 'Delivery worker completed a management task';
  exception when insufficient_privilege then null;
  end;
end $$;

set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare item app.items;
begin
  select * into item from app.items where lot_seq=997863;
  if not exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') r where r->>'id'=item.id::text) then
    raise exception 'Open malfunction task is not visible';
  end if;
  perform app.complete_malfunction_task(item.id,item.malfunction_reported_at);
  perform app.complete_malfunction_task(item.id,item.malfunction_reported_at);
  if exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') r where r->>'id'=item.id::text) then
    raise exception 'Completed malfunction task is still visible';
  end if;
  if not exists(select 1 from app.items where id=item.id and status='動作不良' and malfunction_reported
    and malfunction_resolved_at is null and returned_on is null and packed_on is null
    and sales_channel=item.sales_channel) then
    raise exception 'Completion altered inventory workflow';
  end if;
end $$;

set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
insert into app.item_comments(item_id,author_id,body)
select id,app.current_staff_id(),'Fixture delivery reply' from app.items where lot_seq=997863;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare item app.items;
begin
  select * into item from app.items where lot_seq=997863;
  if not exists(
    select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') r where r->>'id'=item.id::text
  ) then raise exception 'New delivery reply did not reopen the task'; end if;
  perform app.complete_malfunction_task(item.id,item.malfunction_reported_at);
end $$;
reset role;
update app.items set malfunction_reported_at=clock_timestamp() where lot_seq=997863;
set local role authenticated;
do $$
declare item app.items;
begin
  select * into item from app.items where lot_seq=997863;
  begin
    perform app.complete_malfunction_task(item.id,item.malfunction_reported_at - interval '1 minute');
    raise exception 'Old click hid a new report';
  exception when serialization_failure then null;
  end;
  if not exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') r where r->>'id'=item.id::text) then
    raise exception 'New report stayed hidden';
  end if;
end $$;
rollback;

-- The delivery app's no-return decision keeps the refund task through resale.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select fixture.lot_seq,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
       current_date,'Supplier refund fixture',1000,'ヤフオク','メルカリ','fixture'
from (values (997864),(997865)) fixture(lot_seq);

set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'report',status,'Fixture fault')
from app.items where lot_seq in (997864,997865);
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.perform_inventory_action(id,'supplier_check',status) from app.items where lot_seq=997864;
select app.perform_inventory_action(id,'yahoo_instruction',status) from app.items where lot_seq=997865;

set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'return_impossible',status) from app.items where lot_seq=997864;
do $$begin
  if exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') task
    where task->>'lot_seq'='997864') then
    raise exception 'Delivery worker saw a management refund task';
  end if;
end $$;

set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare
  item app.items;
  next_status app.item_status;
begin
  if exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') task
    where task->>'lot_seq'='997865') then
    raise exception 'Regular Yahoo listing instruction produced a refund task';
  end if;

  select * into strict item from app.items where lot_seq=997864;
  if item.status<>'商品登録前' or item.sales_channel<>'ヤフオク' then
    raise exception 'No-return action did not prepare the Yahoo listing';
  end if;
  foreach next_status in array array['商品登録前','出品中','取引中','販売済']::app.item_status[] loop
    if next_status<>item.status then
      perform app.set_inventory_workflow(item.id,next_status);
    end if;
    if not exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') task
      where task->>'id'=item.id::text and task->>'status'=next_status::text and task->>'supplier_refund_pending'='true') then
      raise exception 'Refund task disappeared at status %', next_status;
    end if;
  end loop;

  update app.items set amazon_refund_amount=100,inventory_refund_amount=200 where id=item.id;
  if not exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') task
    where task->>'id'=item.id::text and task->>'supplier_refund_pending'='true') then
    raise exception 'Amazon refunds cleared the supplier refund task';
  end if;
  update app.items set non_amazon_refund_amount=700 where id=item.id;
  if exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('malfunctions')->'rows') task
    where task->>'id'=item.id::text) then
    raise exception 'Refund task remained after the refund was recorded';
  end if;
end $$;
rollback;
