create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,
  i.sku,
  i.lot_seq,
  i.is_accessory,
  i.status,
  i.work_stream,
  i.title,
  i.asin,
  i.condition,
  i.purchased_at,
  i.marketplace,
  i.tracking_no,
  i.accessories,
  i.description,
  i.sales_channel,
  i.planned_price,
  i.deliverer_id,
  buyer.name as purchaser_name,
  i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,
  (i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,
  i.shipped_on,
  i.amazon_returned_on,
  p.image_url as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id = i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id = i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,
  i.description_template,
  i.manufacture_year,
  i.marketplace_item_id
from app.items i
left join app.products p on p.id = i.product_id
left join app.staff buyer on buyer.id = i.purchaser_id
where i.status in ('仕入済', '入荷済', '作業中', 'Amazon返品', '出荷済', '出品中', '販売済');

notify pgrst, 'reload schema';
