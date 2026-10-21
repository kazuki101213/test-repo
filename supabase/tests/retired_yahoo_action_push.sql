begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status)
 values(998681,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'retired action fixture',1000,'ヤフオク','ヤフオク','fixture',now(),now(),'商品登録前');
insert into app.item_comments(item_id,author_id,body,task_kind)
 select (select id from app.items where lot_seq=998681),(select id from app.staff where code='AA'),'instruction retained',kind
 from unnest(array['Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク','SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク','ヤフオク その他','仕入先確認','Amazon販売']) kind;
do $$begin
 if (select count(*) from app.item_comments c join app.items i on i.id=c.item_id where i.lot_seq=998681 and c.task_kind like '%ヤフオク%' and c.body='instruction retained' and c.task_completed_at is null)<>9 then raise exception 'Workflow instructions changed';end if;
 if exists(select 1 from app.admin_push_events e join app.item_comments c on c.id=e.source_id join app.items i on i.id=c.item_id where i.lot_seq=998681 and (c.task_kind like '%ヤフオク%' or c.task_kind='仕入先確認')) then raise exception 'Retired/supplier action created a push';end if;
 if not exists(select 1 from app.admin_push_events e join app.item_comments c on c.id=e.source_id join app.items i on i.id=c.item_id where i.lot_seq=998681 and c.task_kind='Amazon販売') then raise exception 'Unrelated action push suppressed';end if;
end $$;
-- An edited/reopened legacy instruction also must not enqueue a notification.
update app.item_comments set task_completed_at=now() where item_id=(select id from app.items where lot_seq=998681) and task_kind='SONY◯ヤフオク';
update app.item_comments set task_completed_at=null where item_id=(select id from app.items where lot_seq=998681) and task_kind='SONY◯ヤフオク';

insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind)
 select id,'https://web.push.apple.com/retired-yahoo-fixture','fixture-public','fixture-auth','https://bussan-admin.vercel.app/',now()-interval '2 days','admin' from app.staff where code='AA';
-- Simulate an event left behind by the previous implementation.
select app.enqueue_admin_push('action',c.id,c.item_id,null,null,null,clock_timestamp()) from app.item_comments c join app.items i on i.id=c.item_id where i.lot_seq=998681 and c.task_kind='SONY◯ヤフオク';
do $$begin
 if exists(select 1 from app.claim_admin_push() where lot_seq=998681 and task_name like '%ヤフオク%' and eligible) then raise exception 'Legacy queued event still eligible';end if;
end $$;

\ir ../migrations/20261021145855_retire_yahoo_action_push.sql
do $$begin
 if exists(select 1 from app.admin_push_deliveries d join app.admin_push_events e on e.id=d.event_id join app.item_comments c on c.id=e.source_id join app.items i on i.id=c.item_id where i.lot_seq=998681 and c.task_kind like '%ヤフオク%' and d.state in('pending','sending')) then raise exception 'Legacy retries not cancelled';end if;
 if not exists(select 1 from app.items where lot_seq=998681 and sales_channel='ヤフオク') then raise exception 'Sales channel changed';end if;
end $$;
rollback;
