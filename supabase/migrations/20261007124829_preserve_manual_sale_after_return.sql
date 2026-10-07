create or replace function app.items_mark_sold()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Preserve a deliberate sale override without deleting the historic return date.
  -- A newly entered/changed return date still starts return processing.
  if tg_op = 'UPDATE' and new.status = '販売済'
     and old.status in ('返品処理', '販売済')
     and new.returned_on is not null
     and new.returned_on is not distinct from old.returned_on then
    return new;
  end if;
  if new.sold_on is not null
     and not new.is_accessory
     and new.status <> '返品処理'
     and new.amazon_returned_on is null then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then
    new.status := '返品処理';
  end if;
  return new;
end;
$$;
