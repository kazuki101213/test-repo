-- Filter and count using a narrow projection, then build full rows for the selected groups.
do $migration$
declare
  signature constant text := 'app.read_inventory_page(text,jsonb,integer,jsonb)';
  definition text := pg_get_functiondef(signature::regprocedure);
  old_raw constant text := 'with raw as materialized (select to_jsonb(v) d from %s v)';
  old_page constant text := $old$
 page as materialized (
  select enriched.d,d.serial,md5(enriched.d::text) fingerprint,g.lot,g.purchased from
  (select * from data where $1='delivery' union all select * from matched where $1='management') d
  join page_groups g using(serial)
  cross join lateral (select d.d || coalesce(app.inventory_marketplace_accounts((d.d->>'id')::uuid),'{}'::jsonb) d offset 0) enriched
 ),
$old$;
  new_page constant text := $new$
 page_meta as materialized (
  select d.d,d.serial,g.lot,g.purchased
  from (select * from data where $1='delivery' union all select * from matched where $1='management') d
  join page_groups g using(serial)
 ),
 hydrated as materialized (
  select to_jsonb(v) d,v.id
  from %1$s v
  where v.id=any(array(select (m.d->>'id')::uuid from page_meta m))
 ),
 page as materialized (
  select enriched.d,d.serial,md5(enriched.d::text) fingerprint,d.lot,d.purchased
  from page_meta d join hydrated h on h.id=(d.d->>'id')::uuid
  cross join lateral (
   select h.d || d.d || coalesce(app.inventory_marketplace_accounts(h.id),'{}'::jsonb) d
   offset 0
  ) enriched
 ),
$new$;
  search_source constant text := $sources$
case when p_scope='delivery' then $delivery$
 select jsonb_build_object(
  'id',i.id,'sku',i.sku,'lot_seq',i.lot_seq,'is_accessory',i.is_accessory,
  'status',i.status,'marketplace',i.marketplace,'sales_channel',
    case when i.is_accessory then sale.sales_channel else i.sales_channel end,
  'deliverer_id',i.deliverer_id,'purchased_at',i.purchased_at,
  'title',i.title,'model_no',p.model_no,'marketplace_item_id',i.marketplace_item_id,
  'asin',i.asin,'tracking_no',i.tracking_no
 ) d
 from app.items i
 left join app.products p on p.id=i.product_id
   or (i.product_id is null and i.marketplace::text='動作品Amazon返品' and p.asin=i.asin)
 left join lateral (
  select l.sales_channel from app.shared_product_sale_values(i.id) l
  where i.is_accessory offset 0
 ) sale on true
 where (select app.is_admin()) or i.deliverer_id=(select app.current_staff_id())
$delivery$ else $management$
 select jsonb_build_object(
  'id',v.id,'sku',v.sku,'lot_seq',v.lot_seq,'is_accessory',v.is_accessory,
  'status',v.status,'marketplace',v.marketplace,'sales_channel',v.sales_channel,
  'deliverer_id',v.deliverer_id,'purchaser_id',v.purchaser_id,'purchased_at',v.purchased_at,
  'title',v.title,'model_no',v.model_no,'marketplace_item_id',ref.marketplace_item_id,
  'asin',v.asin,'tracking_no',v.tracking_no
 ) d
 from app.v_items v join app.items ref on ref.id=v.id
$management$ end
$sources$;
begin
  if strpos(definition,old_raw)=0 or strpos(definition,old_page)=0
    or strpos(definition,'$query$,source);')=0 then
    raise exception 'Inventory page no longer matches the expected definition';
  end if;
  definition := replace(definition,old_raw,'with raw as materialized (%2$s)');
  definition := replace(definition,old_page,new_page);
  execute replace(definition,'$query$,source);','$query$,source,' || search_source || ');');
end $migration$;
