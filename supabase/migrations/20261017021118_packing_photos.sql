alter table app.item_photos add column photo_kind text not null default 'product'
  check(photo_kind in ('product','packing'));

-- Packing evidence must not reopen product-photo approval or change progress.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('app.invalidate_photo_review()'::regprocedure);
 definition:=replace(definition,'begin','begin' || chr(10) || '  if new.photo_kind=''packing'' then return new;end if;');
 execute definition;
 definition:=pg_get_functiondef('app.handle_deleted_item_photo()'::regprocedure);
 definition:=replace(definition,'begin','begin' || chr(10) || '  if old.photo_kind=''packing'' then return old;end if;');
 definition:=replace(definition,'where item_id = old.item_id;','where item_id = old.item_id and photo_kind=''product'';');
 -- Only item_photos has photo_kind; leave the photo_reviews DELETE unchanged.
 definition:=replace(definition,'delete from app.photo_reviews where item_id = old.item_id and photo_kind=''product'';','delete from app.photo_reviews where item_id = old.item_id;');
 execute definition;
 definition:=pg_get_functiondef('app.approve_photo_review(uuid)'::regprocedure);
 definition:=replace(definition,'from app.item_photos where item_id = p_item_id;','from app.item_photos where item_id = p_item_id and photo_kind=''product'';');
 execute definition;
end $$;

create function app.validate_packing_photo_stage() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item app.items;begin
 if new.photo_kind<>'packing' then return new;end if;
 select * into item from app.items where id=new.item_id;
 if item.id is null or not coalesce(case when item.sales_channel='FBA' then item.status='商品登録前'
   else item.sales_channel in ('自己発送','メルカリ','ヤフオク') and item.status='出品中' end,false) then
   raise exception '現在の販売状態では梱包写真を追加できません' using errcode='22023';
 end if;
 return new;
end $$;
revoke all on function app.validate_packing_photo_stage() from public,anon,authenticated;
create trigger item_photos_validate_packing before insert on app.item_photos
for each row execute function app.validate_packing_photo_stage();
notify pgrst,'reload schema';
