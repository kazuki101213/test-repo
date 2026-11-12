-- Disposable database only. A supplier check can be sent on a manually marked item.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select 997864,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
       current_date,'Supplier check fixture',1000,'ヤフオク','FBA2','fixture',now();
update app.items set status='動作不良' where lot_seq=997864;
insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind)
select id,'https://web.push.apple.com/supplier-check-fixture','fixture','fixture','https://test-repo-delivery.vercel.app/',
       now()-interval '1 day','delivery'
from app.staff where code='DD';
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.perform_inventory_action(id,'supplier_check','動作不良',null,gen_random_uuid()) from app.items where lot_seq=997864;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
  if exists(select 1 from app.items where lot_seq=997864 and malfunction_reported_at is not null) then
    raise exception 'Fixture must have no malfunction report date';
  end if;
  if not exists(select 1 from app.v_delivery_work_tasks where lot_seq=997864 and kind='reply') then
    raise exception 'Supplier check is missing from the delivery task list';
  end if;
end $$;
reset role;
set local role service_role;
create temporary table supplier_check_claims as select app.claim_delivery_push_with_listing_title() as payload;
reset role;
do $$begin
  if not exists(select 1 from supplier_check_claims
    where payload->>'lot_seq'='997864' and payload->>'kind'='reply'
      and payload->>'eligible'='true' and payload->>'reply_task_kind'='仕入先確認'
      and payload->>'endpoint'='https://web.push.apple.com/supplier-check-fixture') then
    raise exception 'Supplier check was not delivered or classified for the assigned worker';
  end if;
end $$;
rollback;
