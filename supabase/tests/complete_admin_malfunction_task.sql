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
