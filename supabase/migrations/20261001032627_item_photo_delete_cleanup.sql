-- Removing any uploaded photo invalidates the previous Drive review submission.
-- The last photo also clears the delivery workflow's photo-complete timestamp.
create or replace function app.handle_deleted_item_photo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_count integer;
begin
  delete from app.photo_reviews where item_id = old.item_id;
  select count(*) into remaining_count from app.item_photos where item_id = old.item_id;
  if remaining_count = 0 then
    update app.items set photo_uploaded_at = null where id = old.item_id;
  end if;
  return old;
end;
$$;

revoke all on function app.handle_deleted_item_photo() from public, anon, authenticated;
drop trigger if exists item_photos_cleanup_after_delete on app.item_photos;
create trigger item_photos_cleanup_after_delete
  after delete on app.item_photos
  for each row execute function app.handle_deleted_item_photo();
