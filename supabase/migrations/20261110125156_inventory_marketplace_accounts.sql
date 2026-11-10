-- Share the installed listing route with the inventory label. Preserve each environment's route.
do $migration$
declare
  definition text := pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
  route_pattern constant text := $pattern$when i\.sales_channel\s*=\s*'メルカリ' then '(mercari-[12])' else '(auctions-[12])' end$pattern$;
  route text[] := regexp_match(definition,route_pattern,'i');
begin
  if route is null then raise exception 'Marketplace listing route could not be located'; end if;
  execute format($function$
    create function app.default_marketplace_seller_account(channel app.sales_channel)
    returns text language sql immutable security invoker set search_path=pg_catalog,app
    as $body$ select case channel when 'メルカリ' then %L when 'ヤフオク' then %L end $body$
  $function$,route[1],route[2]);
  execute regexp_replace(definition,route_pattern,'else app.default_marketplace_seller_account(i.sales_channel) end','i');
end $migration$;

-- The delivery catalog already exposes these items to all active inventory staff.
create function app.inventory_marketplace_accounts(p_item_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,app as $$
  select jsonb_build_object('purchase_account_label',purchase.account_label,'sales_account_label',
    case coalesce(listing.account_id,history.account_id,
      case when coalesce(parent.status,i.status) in ('受取前','検品中','商品登録前','作業中') and coalesce(parent.sold_on,i.sold_on) is null
        then app.default_marketplace_seller_account(coalesce(parent.sales_channel,i.sales_channel)) end)
      when 'mercari-1' then 'メルカリ1' when 'mercari-2' then 'メルカリ2'
      when 'auctions-1' then 'ヤフオク1' when 'auctions-2' then 'ヤフオク2' end)
  from app.items i
  join app.staff viewer on viewer.id=app.current_staff_id() and viewer.is_active
  left join app.items parent on parent.id=i.parent_item_id and not parent.is_accessory
    and i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq)
  left join lateral (
    select d.account_label from app.marketplace_purchase_drafts d
    where d.marketplace=i.marketplace::text
      and (d.id=i.source_purchase_draft_id or d.marketplace_item_id=i.marketplace_item_id)
    order by (d.id=i.source_purchase_draft_id) desc nulls last limit 1
  ) purchase on true
  left join lateral (
    select l.account_id from app.seller_listings l
    where l.item_id=coalesce(parent.id,i.id) and l.channel=coalesce(parent.sales_channel,i.sales_channel)
      and (l.active or (coalesce(parent.status,i.status)='販売済' and l.verified_sale is not null))
    order by l.active desc,l.observed_at desc nulls last,l.id limit 1
  ) listing on true
  left join lateral (
    select o.account_id from app.seller_operations o
    where listing.account_id is null and coalesce(parent.status,i.status)='販売済'
      and o.item_id=coalesce(parent.id,i.id) and o.channel=coalesce(parent.sales_channel,i.sales_channel)
      and o.kind='listing' and o.status='succeeded'
      and nullif(o.result->>'external_id','') is not null
    order by o.created_at desc,o.id limit 1
  ) history on true
  where auth.uid() is not null and i.id=p_item_id
    and viewer.role in ('admin','purchaser','deliverer')
$$;
revoke all on function app.inventory_marketplace_accounts(uuid) from public,anon,authenticated;
grant execute on function app.inventory_marketplace_accounts(uuid) to authenticated;

-- Enrich the selected page before fingerprinting so account-only changes reach cached rows.
do $migration$
declare
  signature text;
  definition text;
  anchor constant text := 'select d.*,md5(d.d::text) fingerprint,g.lot,g.purchased from';
begin
  foreach signature in array array['app.read_inventory_page(text,jsonb,integer,jsonb)',
    'app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Inventory page insertion point missing: %',signature; end if;
    definition := replace(definition,anchor,
      'select enriched.d,d.serial,md5(enriched.d::text) fingerprint,g.lot,g.purchased from');
    execute replace(definition,'join page_groups g using(serial)',
      $sql$join page_groups g using(serial)
  cross join lateral (select d.d || coalesce(app.inventory_marketplace_accounts((d.d->>'id')::uuid),'{}'::jsonb) d offset 0) enriched$sql$);
  end loop;
end $migration$;
