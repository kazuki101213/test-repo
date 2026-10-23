-- A completed current sale is evidence that its shipping reminder is no longer actionable.
-- A sold date alone, an old trade, or an uncertain notification is not completion evidence.
create function app.current_trade_completed(p_item_id uuid) returns boolean
language sql stable security invoker set search_path=pg_catalog,app as $$
 select exists(select 1 from app.items i join app.seller_listings l on l.item_id=i.id
  where i.id=p_item_id and i.status='販売済' and i.seller_cancelled_at is null
   and i.sold_on is not null and i.sold_price is not null and i.payout_amount is not null
   and l.active and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key
   and nullif(l.trade_key,'') is not null and l.observed_status='販売済'
   and l.verified_sale @> jsonb_build_object('sold_on',i.sold_on,'sold_price',i.sold_price,'payout_amount',i.payout_amount));
$$;
revoke all on function app.current_trade_completed(uuid) from public,anon;
grant execute on function app.current_trade_completed(uuid) to authenticated,service_role;

create function app.close_completed_trade_shipping_tasks() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if app.current_trade_completed(new.item_id) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp()
  where item_id=new.item_id and resolved_at is null;
 end if;
 return new;
end $$;
revoke all on function app.close_completed_trade_shipping_tasks() from public,anon,authenticated;
create trigger seller_listings_close_completed_trade_shipping_tasks
 after insert or update of active,trade_key,observed_status,verified_sale on app.seller_listings
 for each row execute function app.close_completed_trade_shipping_tasks();

do $migration$
declare original text; patched text;
begin
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'where t.resolved_at is null and t.created_at<=now()',
  'where t.resolved_at is null and not app.current_trade_completed(i.id) and t.created_at<=now()');
 if patched=original then raise exception 'Shipping task snapshot anchor changed';end if;
 execute patched;
end $migration$;

-- Retain all history and business dates; only resolve tasks supported by current sale evidence.
update app.delivery_shipping_tasks t set resolved_at=clock_timestamp()
where t.resolved_at is null and app.current_trade_completed(t.item_id);
notify pgrst,'reload schema';
