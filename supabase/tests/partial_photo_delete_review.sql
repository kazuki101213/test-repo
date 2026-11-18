begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,photo_uploaded_at)
select 993996,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date,'partial photo delete regression',1000,'ヤフオク','FBA2','regression-photo-delete',now(),now();
do $$
declare
 target uuid := (select id from app.items where lot_seq=993996);
 actor uuid := (select id from app.staff where code='AA');
 sent_at timestamptz := clock_timestamp();
 photo uuid;
 packing uuid;
begin
 insert into app.item_photos(item_id,storage_path,uploaded_by,drive_file_id,photo_kind)
 select target,'regression-partial-delete/'||gen_random_uuid()::text||'.jpg',actor,'drive-fixture-'||n,'product'
 from generate_series(1,3) n;
 insert into app.item_photos(item_id,storage_path,uploaded_by,drive_file_id,photo_kind)
 values(target,'regression-partial-delete/packing.jpg',actor,'packing-fixture','packing') returning id into packing;
 insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at)
 values(target,'regression-folder',3,sent_at);
 select id into photo from app.item_photos where item_id=target and photo_kind='product' limit 1;
 delete from app.item_photos where id=photo;
 if not exists(select 1 from app.photo_reviews where item_id=target and exported_photo_count=2 and submitted_at=sent_at and approved_at is null and rejected_at is null)
 then raise exception 'Pending review lost or changed submission after partial delete';end if;
 if (select photo_uploaded_at from app.items where id=target) is null then raise exception 'Photos-complete cleared with photos remaining';end if;
 delete from app.item_photos where id=packing;
 if not exists(select 1 from app.photo_reviews where item_id=target and exported_photo_count=2 and submitted_at=sent_at)
 then raise exception 'Packing deletion changed product review';end if;
 update app.photo_reviews set approved_at=now(),approved_by=actor where item_id=target;
 select id into photo from app.item_photos where item_id=target and photo_kind='product' limit 1;
 delete from app.item_photos where id=photo;
 if not exists(select 1 from app.photo_reviews where item_id=target and exported_photo_count=1 and approved_at is null and approved_by is null and submitted_at=sent_at)
 then raise exception 'Changed approved photos did not remain pending for review';end if;
 update app.photo_reviews set rejected_at=now(),rejected_by=actor,rejection_reason='fixture rejection' where item_id=target;
 insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind)
 values(target,'regression-partial-delete/unsaved.jpg',actor,'product') returning id into photo;
 delete from app.item_photos where id=photo;
 if not exists(select 1 from app.photo_reviews where item_id=target and rejected_at is not null and rejection_reason='fixture rejection')
 then raise exception 'Deletion bypassed an explicit rejection';end if;
 delete from app.item_photos where item_id=target and photo_kind='product';
 if exists(select 1 from app.photo_reviews where item_id=target) then raise exception 'Empty product review remains';end if;
 if (select photo_uploaded_at from app.items where id=target) is not null then raise exception 'Last product photo did not clear progress';end if;
 if has_function_privilege('authenticated','app.handle_deleted_item_photo()','execute')
 or has_function_privilege('anon','app.handle_deleted_item_photo()','execute')
 then raise exception 'Trigger function exposed to clients';end if;
end $$;
rollback;
