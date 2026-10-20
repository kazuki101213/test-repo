-- Only the authenticated Edge handler may register independent copies of original Drive photos.
create or replace function app.record_reflected_product_photo(p_item_id uuid,p_source_photo_id uuid,p_staff_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,app as $$
declare target app.items; source_item app.items; source_photo app.item_photos; actor app.staff;
 serial text; target_path text; photo_id uuid;
begin
 select * into actor from app.staff where id=p_staff_id and is_active;
 select * into target from app.items where id=p_item_id for update;
 if actor.id is null or target.id is null or (actor.role<>'admin' and target.deliverer_id is distinct from actor.id) then
  raise exception 'Photo permission denied' using errcode='42501';
 end if;
 serial:=substring(target.sku from '^([0-9]+)[aA]+-');
 if serial is null or target.status<>'商品登録前' then raise exception 'Target must be an unlisted a-series item' using errcode='22023';end if;
 select * into source_photo from app.item_photos where id=p_source_photo_id;
 select * into source_item from app.items where id=source_photo.item_id;
 if source_photo.id is null or source_item.lot_seq is distinct from target.lot_seq
  or split_part(source_item.sku,'-',1) is distinct from serial or coalesce(source_item.is_accessory,false)
  or coalesce(source_photo.photo_kind,'product')<>'product' or source_photo.drive_file_id is null or source_photo.uploaded_by is null then
  raise exception 'Source must be an original product photo saved to Drive' using errcode='22023';
 end if;
 target_path:=target.sku||'/reflected-'||source_photo.id::text||'.jpg';
 select id into photo_id from app.item_photos where item_id=target.id and storage_path=target_path;
 if photo_id is not null then return photo_id;end if;
 insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind,created_at)
 values(target.id,target_path,actor.id,'product',clock_timestamp()) returning id into photo_id;
 return photo_id;
end $$;
revoke all on function app.record_reflected_product_photo(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function app.record_reflected_product_photo(uuid,uuid,uuid) to service_role;
