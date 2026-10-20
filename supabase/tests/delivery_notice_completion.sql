begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Notice completion fixture',1000,'メルカリ','メルカリ','fixture','商品登録前'
 from unnest(array[996813,996814]) n;
set local role postgres;
update app.items set malfunction_reported_at=now()-interval '4 days' where lot_seq=996813;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at,approved_at,approved_by)
 select id,'fixture_folder',1,now()-interval '3 days',now()-interval '2 days',purchaser_id from app.items where lot_seq=996813;
insert into app.item_comments(id,item_id,author_id,body,created_at)
 select '99681300-0000-0000-0000-000000000001',id,purchaser_id,'以前の動作不良への返信',now()-interval '2 days' from app.items where lot_seq=996813;
insert into app.delivery_return_tasks(id,item_id,kind,reason,source_at,actor_id,created_at)
 select '99681400-0000-0000-0000-000000000001',id,'photo_return','正面の表示を撮り直してください。',now()-interval '3 days',purchaser_id,now()-interval '2 days' from app.items where lot_seq=996814;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p uuid;stamp timestamptz;begin
 if (select count(*) from app.v_delivery_notice_tasks where lot_seq in(996813,996814))<>3 then raise exception 'Unconfirmed notices expired after one day';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=996814 and reason='正面の表示を撮り直してください。') then raise exception 'Return reason omitted';end if;
 select item_id,approved_at into p,stamp from app.photo_reviews where item_id=(select id from app.items where lot_seq=996813);
 perform app.mark_item_notices_read(p,stamp,stamp);
 if (select count(*) from app.v_delivery_notice_tasks where lot_seq=996813)<>2 then raise exception 'Opening product dismissed cards requiring completion';end if;
 begin insert into app.delivery_notice_completions(staff_id,notice_id,item_id) values(app.current_staff_id(),'forged',p);raise exception 'Client inserted completion';exception when insufficient_privilege then null;end;
end $$;
select app.complete_delivery_notice(id,item_id) from app.v_delivery_notice_tasks where lot_seq=996813;
select app.complete_delivery_notice('reply:99681300-0000-0000-0000-000000000001',(select id from app.items where lot_seq=996813));
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq=996813) then raise exception 'Completed card still visible';end if;
 if (select count(*) from app.delivery_notice_completions where item_id=(select id from app.items where lot_seq=996813))<>2 then raise exception 'Completion duplicated';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq in(996813,996814)) then raise exception 'Other staff read notices';end if;
 if exists(select 1 from app.delivery_notice_completions where item_id=(select id from app.items where lot_seq=996813)) then raise exception 'Other staff read completions';end if;
 begin perform app.complete_delivery_notice('99681400-0000-0000-0000-000000000001',(select id from app.items where lot_seq=996814));raise exception 'Other staff completed notice';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.complete_delivery_notice('99681400-0000-0000-0000-000000000001',(select id from app.items where lot_seq=996814));
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq=996814) then raise exception 'Completed photo return still visible';end if;
 if not exists(select 1 from app.delivery_return_tasks where id='99681400-0000-0000-0000-000000000001' and resolved_at is null) then raise exception 'Completing informational card resolved required work';end if;
end $$;
set local role postgres;
insert into app.item_comments(id,item_id,author_id,body,created_at)
 select '99681300-0000-0000-0000-000000000002',id,purchaser_id,'新しい返信',clock_timestamp() from app.items where lot_seq=996813;
update app.delivery_return_tasks set resolved_at=clock_timestamp() where id='99681400-0000-0000-0000-000000000001';
insert into app.delivery_return_tasks(id,item_id,kind,reason,source_at,actor_id)
 select '99681400-0000-0000-0000-000000000002',id,'photo_return','新しい差し戻し理由',clock_timestamp(),purchaser_id from app.items where lot_seq=996814;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if not exists(select 1 from app.v_delivery_notice_tasks where id='reply:99681300-0000-0000-0000-000000000002') then raise exception 'New reply hidden by older completion';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where id='99681400-0000-0000-0000-000000000002' and reason='新しい差し戻し理由') then raise exception 'New return hidden by older completion';end if;
 if exists(select 1 from app.v_delivery_notice_tasks where id='reply:99681300-0000-0000-0000-000000000001') then raise exception 'Old reply resurfaced';end if;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('photo_reviews');
 -- A pending review must carry its current channel, with no extra fetch per card.
end $$;
set local role postgres;
update app.photo_reviews set approved_at=null where item_id=(select id from app.items where lot_seq=996813);
set local role authenticated;
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('photo_reviews');
 if not exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'item_id'=(select id::text from app.items where lot_seq=996813) and r->'item'->>'sales_channel'='メルカリ') then raise exception 'Photo review channel missing';end if;
end $$;
-- Supplier confirmation keeps the report and message, but never adds an admin action card/push.
set local role postgres;
update app.items set status='動作不良',malfunction_reported=true,malfunction_resolved_at=null,malfunction_reported_at=now()-interval '1 hour' where lot_seq=996814;
set local role authenticated;
select app.send_malfunction_reply('99681400-0000-0000-0000-000000000003',id,'仕入先へ連絡してください。','仕入先確認','{}') from app.items where lot_seq=996814;
do $$declare payload jsonb;begin
 if not exists(select 1 from app.item_comments where id='99681400-0000-0000-0000-000000000003' and task_kind='仕入先確認') then raise exception 'Supplier message lost';end if;
 if not exists(select 1 from app.items where lot_seq=996814 and status='動作不良' and supplier_contact_requested_at is not null) then raise exception 'Supplier confirmation changed report state';end if;
 payload:=app.read_resource_snapshot('actions');
 if exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'id'='99681400-0000-0000-0000-000000000003') then raise exception 'Supplier confirmation made separate action';end if;
 payload:=app.read_resource_snapshot('malfunctions');
 if not exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'id'=(select id::text from app.items where lot_seq=996814)) then raise exception 'Supplier confirmation cleared report';end if;
end $$;
set local role postgres;
do $$begin
 if exists(select 1 from app.admin_push_events where kind='action' and source_id='99681400-0000-0000-0000-000000000003') then raise exception 'Supplier confirmation made admin push';end if;
end $$;
update app.staff set is_active=false where code='DD';
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq in(996813,996814)) then raise exception 'Inactive staff sees notices';end if;
 begin perform app.complete_delivery_notice('reply:99681300-0000-0000-0000-000000000002',(select id from app.items where lot_seq=996813));raise exception 'Inactive staff completed notice';exception when insufficient_privilege then null;end;
end $$;
set local role postgres;
update app.staff set is_active=true where code='DD';
update app.photo_reviews set approved_at=now()-interval '72 hours' where item_id=(select id from app.items where lot_seq=996813);
set local role authenticated;
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq=996813 and kind='photo_approved') then raise exception 'Approval still visible after 72 hours';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=996813 and kind='reply') then raise exception 'Reply expired with approval';end if;
end $$;
rollback;
