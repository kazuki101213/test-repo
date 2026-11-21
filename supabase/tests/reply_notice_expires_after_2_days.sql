-- 「動作不良への返信があります。」は返信から2日以内だけ出る。
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
 select 997002,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Reply expiry fixture',1000,'ヤフオク','メルカリ','fixture','検品中';
set local role postgres;
update app.items set status='動作不良',malfunction_comment='電源が入らない',malfunction_reported_at=now()-interval '5 days' where lot_seq=997002;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.send_malfunction_reply('99700200-0000-4000-8000-000000000001',(select id from app.items where lot_seq=997002),'確認します',null,'{}');
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=997002 and kind='reply' and expires_at is not null) then raise exception 'Fresh reply missing';end if;
end $$;
set local role postgres;
update app.item_comments set created_at=now()-interval '2 days 1 minute' where id='99700200-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq=997002 and kind='reply') then raise exception 'Reply older than 2 days still shown';end if;
end $$;
rollback;
