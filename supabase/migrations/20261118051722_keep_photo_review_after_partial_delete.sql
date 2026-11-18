-- Deleting one product photo must not remove the remaining photo-review task.
-- Keep the original submission identity; packing photos do not affect this review.
create or replace function app.handle_deleted_item_photo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_count integer;
begin
  if old.photo_kind='packing' then return old;end if;
  select count(*) into remaining_count
  from app.item_photos where item_id=old.item_id and photo_kind='product';
  if remaining_count=0 then
    delete from app.photo_reviews where item_id=old.item_id;
    update app.items set photo_uploaded_at=null where id=old.item_id;
  else
    update app.photo_reviews
    set exported_photo_count=remaining_count,
        approved_at=null,approved_by=null,updated_at=now()
    where item_id=old.item_id;
  end if;
  return old;
end;
$$;
revoke all on function app.handle_deleted_item_photo() from public,anon,authenticated;
