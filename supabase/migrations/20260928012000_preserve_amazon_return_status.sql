create or replace function app.items_sync_status() returns trigger language plpgsql as $$
begin
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then return new; end if;
  if new.status='Amazon返品' or new.amazon_returned_on is not null then
    -- Keep the return until a genuinely new shipping date is entered.
    if tg_op='INSERT' or new.shipped_on is null
       or new.shipped_on is not distinct from old.shipped_on
       or (new.amazon_returned_on is not null and new.shipped_on <= new.amazon_returned_on) then
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$$;
