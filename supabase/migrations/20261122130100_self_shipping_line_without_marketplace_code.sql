-- Amazon self-shipping has no flea-market shipping code. A shipping size saved for an earlier
-- Mercari/Yahoo listing must not make the LINE request wait for such a code forever.
CREATE OR REPLACE FUNCTION app.line_shipping_media(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select case
  when required.needs_code and code.id is null then null
  else jsonb_build_object(
   'itemId',i.id,
   'serial',app.product_serial(i.sku,i.lot_seq),
   'sku',i.sku,
   'supplierUrl',case when i.marketplace_url ~ '^https://(auctions\.yahoo\.co\.jp|page\.auctions\.yahoo\.co\.jp|paypayfleamarket\.yahoo\.co\.jp|jp\.mercari\.com|item\.mercari\.com|fril\.jp|item\.fril\.jp|www\.amazon\.co\.jp|amazon\.co\.jp)(/[^[:space:]]*)?$' then i.marketplace_url end,
   'automatic',true,
   'photoPaths',case when front.id is not null and model.id is not null
    then jsonb_build_array(front.storage_path,model.storage_path)
    else coalesce((select jsonb_agg(photo.storage_path order by photo.created_at,photo.id)
     from (select p.id,p.storage_path,p.created_at from app.item_photos p
      where p.item_id=i.id and coalesce(p.photo_kind,'product')='product'
       and p.storage_path ~* '\.(jpe?g|png)$'
      order by p.created_at,p.id limit 2) photo),'[]'::jsonb) end,
   'codeOperationId',code.id,
   'withoutBarcode',case when shipping.code_note is not null then 'carrier_instructions' when not required.needs_code then 'size_unset' end,
   'shipping',case when i.sales_channel='メルカリ' and listing.item_id is not null then jsonb_strip_nulls(jsonb_build_object(
    'method',coalesce(code.payload->>'shippingMethod',shipping.settings->>'shippingMethod'),
    'size',app.mercari_shipping_size(coalesce(code.payload->>'shippingMethod',shipping.settings->>'shippingMethod'),
      coalesce(code.payload->>'size',shipping.settings->>'size')),
    'dropoff',coalesce(code.payload->>'dropoff',shipping.settings->>'dropoff'),
    'note',shipping.code_note,
    'tradeUrl',case when shipping.code_note is not null and listing.external_id ~ '^m[0-9]{8,14}$'
     then 'https://jp.mercari.com/transaction/'||listing.external_id end)) end
  )
 end
 from app.delivery_line_outbox o
 join app.delivery_shipping_tasks t on t.id=o.task_id
 join app.items i on i.id=t.item_id
 left join app.delivery_line_preferences pref on pref.item_id=i.id
 left join app.item_photos front on front.id=pref.overview_photo_id
  and front.item_id=i.id and coalesce(front.photo_kind,'product')='product'
  and front.storage_path ~* '\.(jpe?g|png)$'
 left join app.item_photos model on model.id=pref.model_photo_id
  and model.item_id=i.id and coalesce(model.photo_kind,'product')='product'
  and model.storage_path ~* '\.(jpe?g|png)$'
 left join app.seller_listings listing on listing.item_id=i.id and listing.active
  and listing.trade_key=o.trade_key
 left join lateral (
  select cfg.settings,app.mercari_shipping_code_note(cfg.settings->>'size',cfg.settings->>'dropoff') as code_note
  from (select app.mercari_item_shipping_defaults(i.id) as settings) cfg
  where i.sales_channel='メルカリ' and listing.item_id is not null
 ) shipping on true
 left join lateral (
  -- Only flea-market trades issue shipping codes; Amazon self-shipping never waits for one.
  select shipping.code_note is null and app.sales_channel_family(i.sales_channel) is distinct from '自己発送'
    and (app.line_fixed_shipping_size(i.id) is not null
    or (i.sales_channel='メルカリ' and nullif(pref.shipping->>'size','') is not null)) as needs_code
 ) required on true
 left join lateral (
  select op.id,op.payload from app.seller_operations op
  where listing.item_id is not null
   and (case when i.shipped_on is not null then op.id=o.code_issue_operation_id else required.needs_code end)
   and op.item_id=i.id and op.account_id=listing.account_id and op.channel=listing.channel
   and op.kind in ('shipping_code','register_package') and op.status='succeeded'
   and op.payload->>'trade_key'=o.trade_key
   and nullif(op.result->>'qr_code','') is not null
   and (i.sales_channel<>'メルカリ' or (
    op.payload->>'shippingMethod' is not distinct from shipping.settings->>'shippingMethod'
    and op.payload->>'dropoff' is not distinct from shipping.settings->>'dropoff'
    and not (op.payload->>'shippingMethod'='らくらくメルカリ便' and op.payload->>'size'='140')
    and app.mercari_shipping_size(op.payload->>'shippingMethod',op.payload->>'size') is not distinct from shipping.settings->>'size'))
  order by op.created_at desc limit 1
 ) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id);
$function$;
