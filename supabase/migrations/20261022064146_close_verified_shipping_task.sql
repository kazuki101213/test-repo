-- A verified notification closes the current request, without guessing a dispatch date.
create function app.close_verified_shipping_task() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if new.kind<>'ship_notice' or new.status<>'succeeded' or new.result->>'notified' is distinct from 'true'
  or nullif(new.payload->>'trade_key','') is null then return new;end if;
 perform 1 from app.items i join app.seller_listings l on l.item_id=i.id and l.active
 where i.id=new.item_id and i.sales_channel=new.channel and l.channel=new.channel
  and l.account_id=new.account_id and l.trade_key=new.payload->>'trade_key'
  and i.seller_trade_key=new.payload->>'trade_key'
 for update of i;
 if not found then return new;end if;
 update app.delivery_shipping_tasks set resolved_at=clock_timestamp()
 where item_id=new.item_id and resolved_at is null and created_at<=new.created_at;
 return new;
end $$;
revoke all on function app.close_verified_shipping_task() from public,anon,authenticated;
create trigger seller_operations_close_verified_shipping_task
 after update of status,result on app.seller_operations
 for each row execute function app.close_verified_shipping_task();
