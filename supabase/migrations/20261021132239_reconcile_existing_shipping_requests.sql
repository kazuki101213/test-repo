-- The earlier safeguard only ran on the next status observation. Repair rows
-- already observed before it was installed, without waiting for another scan.
-- A shipment on/after the purchase date and completed/cancelled sales are kept.
drop trigger items_clear_prior_trade_shipping_date on app.items;
create trigger items_clear_prior_trade_shipping_date
 before update of status,seller_trade_key,sales_channel,shipped_on on app.items
 for each row execute function app.clear_prior_trade_shipping_date();

create or replace function app.capture_shipping_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中'
  and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;

-- Only current, exactly matched marketplace trades can be reconciled in bulk.
-- Touching status also restores a missing request when shipped_on was already null.
update app.items i set status=i.status
where i.status='取引中' and i.sold_on is null
 and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
 and exists(select 1 from app.seller_listings l where l.item_id=i.id and l.active
  and l.channel=i.sales_channel and l.observed_status='取引中'
  and l.trade_key=i.seller_trade_key)
 and ((i.shipped_on is not null
   and i.seller_trade_key ~ '^[a-z][0-9]+:20[0-9]{2}-[01][0-9]-[0-3][0-9](T[0-2][0-9]:[0-5][0-9])?$'
   and substring(i.seller_trade_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})')>to_char(i.shipped_on,'YYYY-MM-DD'))
  or (i.shipped_on is null and not exists(select 1 from app.delivery_shipping_tasks t
   where t.item_id=i.id and t.resolved_at is null)));

notify pgrst,'reload schema';
