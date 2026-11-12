-- Synthetic conversations only. This test does not send push requests.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select n,(select id from app.staff where code='EE'),(select id from app.staff where code='DD'),
       current_date,'Notification fixture',1000,'ヤフオク','FBA2','fixture',now()
from unnest(array[997861,997862]) n;
update app.items
set status='動作不良',malfunction_reported=true,malfunction_reported_at=clock_timestamp()-interval '1 minute'
where lot_seq=997861;

set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
insert into app.item_comments(id,item_id,author_id,body)
select case lot_seq when 997861 then '99786100-0000-4000-8000-000000000001'::uuid
  else '99786200-0000-4000-8000-000000000001'::uuid end,id,app.current_staff_id(),'Fixture message'
from app.items where lot_seq in (997861,997862);
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.send_malfunction_reply('99786100-0000-4000-8000-000000000002',id,'Fixture reply',null)
from app.items where lot_seq=997861;
reset role;

do $$begin
  if (select array_agg(s.code::text order by s.code)
      from app.admin_push_events e join app.staff s on s.id=e.staff_id
      where e.kind='malfunction_message' and e.source_id='99786100-0000-4000-8000-000000000001')
    is distinct from array['AA','EE']::text[] then
    raise exception 'Delivery message did not notify the admin and the assigned purchaser only';
  end if;
  if exists(select 1 from app.admin_push_events where kind='malfunction_message'
    and source_id in ('99786200-0000-4000-8000-000000000001','99786100-0000-4000-8000-000000000002')) then
    raise exception 'Ordinary comment or outgoing reply notified management';
  end if;
  if not exists(select 1 from app.delivery_push_events e join app.item_comments c on c.item_id=e.item_id and c.created_at=e.event_at
    join app.staff s on s.id=e.staff_id where s.code='DD' and e.kind='reply' and c.id='99786100-0000-4000-8000-000000000002') then
    raise exception 'Outgoing management reply did not notify the delivery worker';
  end if;
end $$;

insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind)
select id,'https://web.push.apple.com/fixture-'||code,'fixture','fixture','https://bussan-admin.vercel.app/',
       now()-interval '1 day','admin'
from app.staff where code in ('AA','EE');
-- Changing the purchaser after send must prevent the previous purchaser's device from receiving it.
update app.items set purchaser_id=(select id from app.staff where code='AA') where lot_seq=997861;
set local role service_role;
create temporary table claimed_message_push as
select lot_seq,kind,task_id,eligible,endpoint from app.claim_admin_push();
reset role;
do $$begin
  if not exists(select 1 from claimed_message_push where lot_seq=997861 and kind='malfunction_message'
    and task_id='99786100-0000-4000-8000-000000000001' and eligible and endpoint='https://web.push.apple.com/fixture-AA') then
    raise exception 'Management reply notification could not be dispatched';
  end if;
  if not exists(select 1 from claimed_message_push where lot_seq=997861 and kind='malfunction_message'
    and not eligible and endpoint='https://web.push.apple.com/fixture-EE') then
    raise exception 'A previous purchaser remained eligible';
  end if;
end $$;
rollback;
