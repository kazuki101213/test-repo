-- A date inconsistency is not evidence that a shipment has not happened.
-- Never erase a shipping date or create a request solely from that inference.
drop trigger if exists items_clear_prior_trade_shipping_date on app.items;

create or replace function app.capture_shipping_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中' and (old.status is distinct from new.status or old.shipped_on is not null)
  and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;

-- Reverse only the two unapproved automatic corrections, and only if no later
-- item update has occurred. Explicitly approved corrections (2366) are preserved.
update app.items i set shipped_on=(a.old_data->>'shipped_on')::date
from app.audit_log a
where i.sku in ('2362-AALL-20260920-2200','2323-AALL-20260915-1310')
 and i.status='取引中' and i.sold_on is null and i.shipped_on is null
 and a.table_name='items' and a.row_id=i.id and a.created_at=i.updated_at
 and a.old_data->>'shipped_on' is not null and a.new_data->>'shipped_on' is null
 and a.old_data->>'status'='取引中' and a.new_data->>'status'='取引中';

notify pgrst,'reload schema';
