begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select 993001,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'packing regression',1000,'ヤフオク','FBA','123';
select app.perform_inventory_action(id,'inspection_complete',status) from app.items where lot_seq=993001;
set local role postgres;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at)
select id,'existing-folder',1,now() from app.items where lot_seq=993001;
set local role authenticated;
do $$declare target uuid:=(select id from app.items where lot_seq=993001); photo uuid; channel app.sales_channel;begin
 insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind)
 values(target,'test/packing.jpg',app.current_staff_id(),'packing') returning id into photo;
 if not exists(select 1 from app.photo_reviews where item_id=target and approved_at is not null) then raise exception 'Packing upload reset product approval';end if;
 delete from app.item_photos where id=photo;
 if not exists(select 1 from app.photo_reviews where item_id=target and approved_at is not null) then raise exception 'Packing deletion reset product approval';end if;
 for channel in select unnest(array['自己発送','メルカリ','ヤフオク']::app.sales_channel[]) loop
  update app.items set sales_channel=channel,status='出品中' where id=target;
  insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind) values(target,'test/packing-'||channel,app.current_staff_id(),'packing');
 end loop;
 update app.items set status='取引中' where id=target;
 begin
  insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind) values(target,'test/wrong-stage',app.current_staff_id(),'packing');
  raise exception 'Wrong-stage packing accepted';
 exception when invalid_parameter_value then null;end;
 update app.items set status='商品登録前' where id=target;
 insert into app.item_photos(item_id,storage_path,uploaded_by) values(target,'test/product',app.current_staff_id());
 if exists(select 1 from app.photo_reviews where item_id=target and approved_at is not null) then raise exception 'Product upload no longer resets approval';end if;
end $$;
rollback;
