-- A completed FBA workflow and its inventory dispatch date commit together.
create function app.record_fba_completion_dispatch_date()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  requested_at timestamptz;
begin
  if old.stage <> 'placement-confirmed' or old.pending->>'action' is distinct from 'confirmTransport'
    or new.pending is not null or new.amazon_id is null then
    return new;
  end if;

  requested_at := coalesce(new.work->>'dispatchRequestedAt', old.pending->>'at')::timestamptz;
  if requested_at is null or requested_at < new.created_at or requested_at > clock_timestamp() then
    return new;
  end if;

  update app.items i set shipped_on = (requested_at at time zone 'Asia/Tokyo')::date
  from app.fba_inbound_items f
  where f.plan_id = new.id and f.released_at is null and i.id = f.item_id
    and i.sku = f.sku and btrim(i.asin::text) = f.asin and i.deliverer_id = new.staff_id
    and i.shipped_on is null and i.sold_on is null and i.status in ('商品登録前', '出品中')
    and (i.sales_channel::text = new.account or (new.account = 'FBA1' and i.sales_channel = 'FBA'));
  return new;
end;
$$;
revoke all on function app.record_fba_completion_dispatch_date() from public, anon, authenticated;

create trigger fba_inbound_record_completion_dispatch_date
after update of stage on app.fba_inbound_plans
for each row when (old.stage is distinct from new.stage and new.stage = 'ready')
execute function app.record_fba_completion_dispatch_date();
