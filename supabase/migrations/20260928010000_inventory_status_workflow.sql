-- A purchase starts in work; shipping makes it listed. Preserve final/manual states.
alter table app.items alter column status set default '作業中';

create or replace function app.items_sync_status() returns trigger language plpgsql as $$
begin
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then return new; end if;
  if new.amazon_returned_on is not null or new.status = 'Amazon返品' then
    if new.shipped_on is null or (new.amazon_returned_on is not null and new.shipped_on <= new.amazon_returned_on) then
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$$;

drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status before insert or update of status, arrived_on, product_registered_at,
  inspected_at, cleaned_at, photo_uploaded_at, packed_on, shipped_on, listed_on, amazon_returned_on
  on app.items for each row execute function app.items_sync_status();

update app.items set status='作業中' where status in ('仕入済','入荷済');
update app.items set status='出品中' where status='出荷済';
notify pgrst, 'reload schema';
