begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status)
 select 996812,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Packing notice fixture',1000,'メルカリ','FBA','fixture','検品中';
select app.perform_inventory_action(id,'inspection_complete',status) from app.items where lot_seq=996812;
set local role postgres;
insert into app.item_photos(id,item_id,storage_path,uploaded_by,drive_file_id,photo_kind)
 select '99681200-0000-0000-0000-000000000001',id,'packing-fixture/front.jpg',deliverer_id,'fixture_private_file','packing' from app.items where lot_seq=996812;
insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind)
 select id,'https://web.push.apple.com/packing-fixture','fixture-public','fixture-auth','https://test-repo-delivery.vercel.app/',now()-interval '2 days','admin' from app.staff where code='AA';
select app.record_packing_photo_notice(id,'99681200-0000-0000-0000-000000000001',1) from app.items where lot_seq=996812;
create temporary table packing_stamp as select submitted_at from app.packing_photo_notices where item_id=(select id from app.items where lot_seq=996812);
select app.record_packing_photo_notice(id,'99681200-0000-0000-0000-000000000001',1) from app.items where lot_seq=996812;
do $$begin
 if (select submitted_at from app.packing_photo_notices where item_id=(select id from app.items where lot_seq=996812))<>(select submitted_at from packing_stamp) then raise exception 'Same batch created another notice';end if;
 if not exists(select 1 from app.claim_admin_push() where lot_seq=996812 and kind='packing_photo' and eligible) then raise exception 'Packing push missing';end if;
end $$;
set local role authenticated;
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('packing_photos');
 if not exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'item_id'=(select id::text from app.items where lot_seq=996812)) then raise exception 'Admin task missing';end if;
 begin perform app.acknowledge_packing_photos((select id from app.items where lot_seq=996812),now()-interval '1 day');raise exception 'Stale confirmation allowed';exception when serialization_failure then null;end;
end $$;
select app.acknowledge_packing_photos(item_id,submitted_at) from app.packing_photo_notices where item_id=(select id from app.items where lot_seq=996812);
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('packing_photos');
 if exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'item_id'=(select id::text from app.items where lot_seq=996812)) then raise exception 'Checked task still visible';end if;
 if (select status from app.items where lot_seq=996812)<>'商品登録前' then raise exception 'Confirmation changed inventory state';end if;
 if exists(select 1 from app.photo_reviews where item_id=(select id from app.items where lot_seq=996812)) then raise exception 'Packing entered product approval';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if exists(select 1 from app.packing_photo_notices) then raise exception 'Deliverer read admin notices';end if;
 begin perform app.read_resource_snapshot('packing_photos');raise exception 'Deliverer read admin snapshot';exception when insufficient_privilege then null;end;
 begin perform app.acknowledge_packing_photos((select id from app.items where lot_seq=996812),now());raise exception 'Deliverer acknowledged';exception when insufficient_privilege then null;end;
 begin perform app.record_packing_photo_notice((select id from app.items where lot_seq=996812),'99681200-0000-0000-0000-000000000001',1);raise exception 'Client forged upload';exception when insufficient_privilege then null;end;
end $$;
set local role postgres;
insert into app.item_photos(id,item_id,storage_path,uploaded_by,drive_file_id,photo_kind,created_at)
 select '99681200-0000-0000-0000-000000000002',id,'packing-fixture/back.jpg',deliverer_id,'fixture_private_file_2','packing',clock_timestamp()+interval '1 second' from app.items where lot_seq=996812;
select app.record_packing_photo_notice(id,'99681200-0000-0000-0000-000000000002',2) from app.items where lot_seq=996812;
do $$begin
 if not exists(select 1 from app.packing_photo_notices where item_id=(select id from app.items where lot_seq=996812) and checked_at is null and photo_count=2) then raise exception 'New batch failed to reopen notice';end if;
 update app.admin_push_deliveries set next_attempt_at=now(),state='pending';
 if exists(select 1 from app.claim_admin_push() c join app.admin_push_deliveries d on d.id=c.delivery_id join app.admin_push_events e on e.id=d.event_id where c.kind='packing_photo' and c.lot_seq=996812 and e.event_at=(select submitted_at from packing_stamp) and c.eligible) then raise exception 'Old notification eligible';end if;
end $$;
rollback;
