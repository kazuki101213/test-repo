-- 返送依頼の返信は納品アプリに「返送お願いします。」(return_request) として出て、
-- 動作不良でなくなると消える。普通の返信は従来どおり「返信があります」(reply)。
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
 select 997001,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Return request fixture',1000,'ヤフオク','メルカリ','fixture','検品中';
set local role postgres;
update app.items set status='動作不良',malfunction_comment='電源が入らない',malfunction_reported_at=now()-interval '1 hour' where lot_seq=997001;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.send_malfunction_reply('99700100-0000-4000-8000-000000000001',(select id from app.items where lot_seq=997001),'【997001】着払いでお願いします。',null,'{}',true);
select app.send_malfunction_reply('99700100-0000-4000-8000-000000000002',(select id from app.items where lot_seq=997001),'普通の返信',null,'{}');
-- 同じ内容の再送は受け付け、返送依頼かどうかが違う再送は重複として拒否する。
select app.send_malfunction_reply('99700100-0000-4000-8000-000000000001',(select id from app.items where lot_seq=997001),'【997001】着払いでお願いします。',null,'{}',true);
do $$begin
 begin
  perform app.send_malfunction_reply('99700100-0000-4000-8000-000000000001',(select id from app.items where lot_seq=997001),'【997001】着払いでお願いします。',null,'{}',false);
  raise exception 'Return request flag changed on retry';
 exception when invalid_parameter_value then null;
 end;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=997001 and kind='return_request' and id='return_request:99700100-0000-4000-8000-000000000001') then raise exception 'Return request card missing';end if;
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq=997001 and kind='reply' and id='reply:99700100-0000-4000-8000-000000000001') then raise exception 'Return request also shown as reply';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=997001 and kind='reply' and id='reply:99700100-0000-4000-8000-000000000002') then raise exception 'Normal reply missing';end if;
end $$;
set local role postgres;
update app.items set status='返品処理' where lot_seq=997001;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq=997001 and kind='return_request') then raise exception 'Return request card stayed after return';end if;
end $$;
rollback;
