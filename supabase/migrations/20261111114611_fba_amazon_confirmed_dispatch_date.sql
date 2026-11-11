-- Amazon returns the transportation operation result without a completion
-- timestamp. The JST date is certain only when both bounds fall on that date.
create or replace function app.record_fba_completion_dispatch_date()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  last_unconfirmed_at timestamptz;
  observed_at timestamptz;
  confirmed_on date;
begin
  if old.stage <> 'placement-confirmed' or old.pending->>'action' is distinct from 'confirmTransport'
    or nullif(old.pending->>'op', '') is null or new.pending is not null or new.amazon_id is null then
    return new;
  end if;

  last_unconfirmed_at := greatest(
    (old.pending->>'at')::timestamptz,
    (old.pending->>'transportStillPendingAt')::timestamptz
  );
  observed_at := (new.work->>'transportConfirmationObservedAt')::timestamptz;
  if last_unconfirmed_at is null or observed_at is null or last_unconfirmed_at < new.created_at
    or observed_at < last_unconfirmed_at or observed_at > clock_timestamp() then
    return new;
  end if;
  confirmed_on := (observed_at at time zone 'Asia/Tokyo')::date;
  if confirmed_on <> (last_unconfirmed_at at time zone 'Asia/Tokyo')::date then
    return new;
  end if;

  update app.items i set shipped_on = confirmed_on
  from app.fba_inbound_items f
  where f.plan_id = new.id and f.released_at is null and i.id = f.item_id
    and i.sku = f.sku and btrim(i.asin::text) = f.asin and i.deliverer_id = new.staff_id
    and i.shipped_on is null and i.sold_on is null and i.status in ('商品登録前', '出品中')
    and (i.sales_channel::text = new.account or (new.account = 'FBA1' and i.sales_channel = 'FBA'));
  return new;
end;
$$;
