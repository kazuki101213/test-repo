begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
 select 996811,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Return review fixture',1000,'メルカリ','メルカリ','fixture','検品中';
set local role postgres;
insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind) select id,'https://web.push.apple.com/return-fixture','fixture-public','fixture-auth','https://test-repo-delivery.vercel.app/',now()-interval '2 days','delivery' from app.staff where code='DD';
insert into app.item_photos(item_id,storage_path,uploaded_by,drive_file_id)
 select id,'return-fixture/front.jpg',deliverer_id,'fixture_private_file' from app.items where lot_seq=996811;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at)
 select id,'fixture_folder',1,now()-interval '1 hour' from app.items where lot_seq=996811;
set local role authenticated;
do $$begin
 begin perform app.reject_photo_review((select id from app.items where lot_seq=996811),now(),' ','99681100-0000-0000-0000-000000000001');raise exception 'Blank reason allowed';exception when invalid_parameter_value then null;end;
 begin perform app.reject_photo_review((select id from app.items where lot_seq=996811),now(),'stale','99681100-0000-0000-0000-000000000001');raise exception 'Stale review rejected';exception when serialization_failure then null;end;
end $$;
select app.reject_photo_review(item_id,submitted_at,'正面写真を撮り直してください。','99681100-0000-0000-0000-000000000001')
 from app.photo_reviews where item_id=(select id from app.items where lot_seq=996811);
select app.reject_photo_review(item_id,submitted_at,'正面写真を撮り直してください。','99681100-0000-0000-0000-000000000001')
 from app.photo_reviews where item_id=(select id from app.items where lot_seq=996811);
do $$declare snapshot jsonb;begin
 if (select status from app.items where lot_seq=996811)<>'検品中' then raise exception 'Photo NG changed stock state';end if;
 if (select count(*) from app.delivery_return_tasks where id='99681100-0000-0000-0000-000000000001')<>1 then raise exception 'Duplicate return task';end if;
 begin perform app.approve_photo_review((select id from app.items where lot_seq=996811));raise exception 'Returned photos approved';exception when invalid_parameter_value then null;end;
 snapshot:=app.read_resource_snapshot('photo_reviews');
 if exists(select 1 from jsonb_array_elements(snapshot->'rows') r where r->>'item_id'=(select id::text from app.items where lot_seq=996811)) then raise exception 'Rejected photo stayed in admin queue';end if;
end $$;
set local role postgres;
do $$begin
 if not exists(select 1 from app.delivery_push_events where item_id=(select id from app.items where lot_seq=996811) and kind='photo_return') then raise exception 'No return push event';end if;
 if not exists(select 1 from app.claim_delivery_push() where kind='photo_return' and lot_seq=996811 and eligible) then raise exception 'Photo return notification not eligible';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin if exists(select 1 from app.delivery_return_tasks where id='99681100-0000-0000-0000-000000000001') then raise exception 'Other assignee read reason';end if;end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if not exists(select 1 from app.v_delivery_return_tasks where id='99681100-0000-0000-0000-000000000001') then raise exception 'Assigned staff cannot read reason';end if;
 begin update app.delivery_return_tasks set resolved_at=now() where id='99681100-0000-0000-0000-000000000001';raise exception 'Staff manually cleared return';exception when insufficient_privilege then null;end;
 begin perform app.reject_photo_review((select id from app.items where lot_seq=996811),now(),'Unauthorized','99681100-0000-0000-0000-000000000099');raise exception 'Staff rejected review';exception when insufficient_privilege then null;end;
end $$;
set local role postgres;
update app.photo_reviews set submitted_at=clock_timestamp() where item_id=(select id from app.items where lot_seq=996811);
do $$begin
 if exists(select 1 from app.delivery_return_tasks where item_id=(select id from app.items where lot_seq=996811) and resolved_at is null) then raise exception 'Resubmission retained photo task';end if;
 if exists(select 1 from app.photo_reviews where item_id=(select id from app.items where lot_seq=996811) and rejected_at is not null) then raise exception 'Resubmission remained rejected';end if;
 update app.delivery_push_deliveries set next_attempt_at=now(),state='pending';
 if exists(select 1 from app.claim_delivery_push() where kind='photo_return' and lot_seq=996811 and eligible) then raise exception 'Resolved photo return still eligible';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'report','検品中','動作不良です。') from app.items where lot_seq=996811;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin
 begin perform app.perform_inventory_action((select id from app.items where lot_seq=996811),'send_back','動作不良');raise exception 'Report return without reason';exception when invalid_parameter_value then null;end;
end $$;
select app.perform_inventory_action(id,'send_back','動作不良','接続を確認して再検品してください。','99681100-0000-0000-0000-000000000002') from app.items where lot_seq=996811;
select app.perform_inventory_action(id,'send_back','動作不良','接続を確認して再検品してください。','99681100-0000-0000-0000-000000000002') from app.items where lot_seq=996811;
do $$begin
 if (select status from app.items where lot_seq=996811)<>'検品中' then raise exception 'Report did not return to inspection';end if;
 if (select count(*) from app.v_delivery_return_tasks where id='99681100-0000-0000-0000-000000000002')<>1 then raise exception 'Report return task missing/duplicated';end if;
end $$;
set local role postgres;
do $$begin
 if not exists(select 1 from app.item_comments where id='99681100-0000-0000-0000-000000000002' and body like '%接続を確認%') then raise exception 'Return reason missing from product messages';end if;
 if exists(select 1 from app.delivery_push_events where item_id=(select id from app.items where lot_seq=996811) and kind='reply') then raise exception 'Return generated duplicate generic reply push';end if;
 if not exists(select 1 from app.claim_delivery_push() where lot_seq=996811 and kind='malfunction_return' and eligible) then raise exception 'Report return push not eligible';end if;
end $$;
update app.delivery_return_tasks set created_at=clock_timestamp()-interval '25 hours' where id='99681100-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where item_id=(select id from app.items where lot_seq=996811)) then raise exception 'Expired return card remains visible';end if;
 if not exists(select 1 from app.v_delivery_return_tasks where id='99681100-0000-0000-0000-000000000002') then raise exception 'Expiry erased unresolved work';end if;
end $$;
select app.perform_inventory_action(id,'inspection_complete','検品中') from app.items where lot_seq=996811;
do $$begin if exists(select 1 from app.v_delivery_return_tasks where item_id=(select id from app.items where lot_seq=996811)) then raise exception 'Reinspection retained return task';end if;end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.approve_photo_review((select id from app.items where lot_seq=996811));
insert into app.item_comments(item_id,author_id,body) select id,app.current_staff_id(),'再確認への返信です。' from app.items where lot_seq=996811;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if not exists(select 1 from app.v_delivery_notice_tasks where kind='photo_approved' and item_id=(select id from app.items where lot_seq=996811)) then raise exception 'Approval card missing';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where kind='reply' and item_id=(select id from app.items where lot_seq=996811)) then raise exception 'Reply card missing';end if;
end $$;
set local role postgres;
update app.photo_reviews set approved_at=clock_timestamp()-interval '25 hours' where item_id=(select id from app.items where lot_seq=996811);
update app.item_comments set created_at=clock_timestamp()-interval '25 hours' where item_id=(select id from app.items where lot_seq=996811);
set local role authenticated;
do $$begin if exists(select 1 from app.v_delivery_notice_tasks where item_id=(select id from app.items where lot_seq=996811)) then raise exception 'Expired approval/reply card visible';end if;end $$;
set local role postgres;
update app.staff set is_active=false where code='DD';
set local role authenticated;
do $$begin if exists(select 1 from app.delivery_return_tasks where id in ('99681100-0000-0000-0000-000000000001','99681100-0000-0000-0000-000000000002')) then raise exception 'Inactive staff read history';end if;end $$;
rollback;
