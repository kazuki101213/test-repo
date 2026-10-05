create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  case when i.is_accessory then shared.sales_channel else i.sales_channel end as sales_channel,
  i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id=i.product_id
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','返品処理','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;
