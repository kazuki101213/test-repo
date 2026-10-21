-- A shipping date preceding the confirmed purchase belongs to an older episode.
-- Changing the current row is audited by the existing items_audit trigger.
create function app.clear_prior_trade_shipping_date() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if new.status='取引中' and new.sold_on is null and new.shipped_on is not null
  and new.sales_channel in ('メルカリ','ヤフオク','自己発送')
  and new.seller_trade_key ~ '^[a-z][0-9]+:20[0-9]{2}-[01][0-9]-[0-3][0-9](T[0-2][0-9]:[0-5][0-9])?$'
  and substring(new.seller_trade_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})') > to_char(new.shipped_on,'YYYY-MM-DD')
 then new.shipped_on:=null;end if;
 return new;
end $$;
revoke all on function app.clear_prior_trade_shipping_date() from public,anon,authenticated;
create trigger items_clear_prior_trade_shipping_date
 before update of status,seller_trade_key,sales_channel on app.items
 for each row execute function app.clear_prior_trade_shipping_date();

-- Restoring an erroneously shipped current trade must also restore its request.
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
notify pgrst,'reload schema';
