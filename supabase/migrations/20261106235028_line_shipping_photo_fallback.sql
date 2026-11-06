-- Photo selection is optional for automatic shipping requests. Keep the
-- current-trade code requirement for catalog products with a configured size.
create or replace function app.line_shipping_media(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select case
  when required.shipping_size is not null and code.id is null then null
  else jsonb_build_object(
   'itemId',i.id,
   'serial',app.product_serial(i.sku,i.lot_seq),
   'sku',i.sku,
   'supplierUrl',i.marketplace_url,
   'automatic',true,
   'photoPaths',case when front.id is not null and model.id is not null
    then jsonb_build_array(front.storage_path,model.storage_path)
    else coalesce((select jsonb_agg(photo.storage_path order by photo.created_at,photo.id)
     from (select p.id,p.storage_path,p.created_at from app.item_photos p
      where p.item_id=i.id and coalesce(p.photo_kind,'product')='product'
       and p.storage_path ~* '\.(jpe?g|png)$'
      order by p.created_at,p.id limit 2) photo),'[]'::jsonb) end,
   'codeOperationId',case when required.shipping_size is not null then code.id end,
   'withoutBarcode',case when required.shipping_size is null then 'size_unset' end
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
 left join lateral (select app.line_fixed_shipping_size(i.id) as shipping_size) required on true
 left join lateral (
  select op.id from app.seller_operations op
  where required.shipping_size is not null and listing.item_id is not null
   and op.item_id=i.id and op.account_id=listing.account_id and op.channel=listing.channel
   and op.kind in ('shipping_code','register_package') and op.status='succeeded'
   and op.payload->>'trade_key'=o.trade_key
   and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null
  order by op.created_at desc limit 1
 ) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id);
$$;

-- CREATE OR REPLACE preserves the existing service-only execution privileges.
notify pgrst,'reload schema';
