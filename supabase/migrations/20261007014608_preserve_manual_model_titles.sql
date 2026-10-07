-- Both apps read the same live catalog model. Existing product links take priority;
-- ASIN is an exact, unique fallback for working Amazon returns without a product link.
-- Never use the historical FNSKU stored in items.title as a model number.
create or replace view app.v_items with (security_invoker = on) as
select
  i.id,
  i.sku,
  i.lot_seq,
  i.is_accessory,
  i.status,
  i.condition,
  i.title,
  i.asin,
  p.model_no,
  p.maker,
  p.genre,
  p.turnover,
  i.purchased_at,
  i.cost_amount,
  i.marketplace,
  i.marketplace_url,
  c.name              as card_name,
  buyer.name          as purchaser_name,
  deliv.name          as deliverer_name,
  i.work_stream,
  i.deliverer_id,
  i.purchaser_id,
  i.tracking_no,
  i.planned_price,
  i.planned_payout,
  i.sales_channel,
  i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null)          as inspected,
  (i.photo_uploaded_at is not null)     as photo_uploaded,
  i.packed_on,
  i.shipped_on,
  i.listed_on,
  i.sold_on,
  i.sold_price,
  i.payout_amount,
  i.amazon_returned_on,
  i.refund_amount,
  i.profit,
  -- 仕入から販売までの日数（回転日数）
  (i.sold_on - i.purchased_at)          as days_to_sell,
  -- 未販売なら仕入からの経過日数
  case when i.sold_on is null then current_date - i.purchased_at end as days_in_stock,
  case
    when i.planned_payout is not null
      then i.planned_payout - i.cost_amount
  end                                   as expected_profit,
  i.accessories,
  i.memo,
  i.updated_at
from app.items i
left join app.products p on p.id = i.product_id
  or (i.product_id is null and i.marketplace::text = '動作品Amazon返品' and p.asin = i.asin)
left join app.payment_cards c on c.id = i.card_id
left join app.staff buyer    on buyer.id = i.purchaser_id
left join app.staff deliv    on deliv.id = i.deliverer_id;

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
  p.model_no as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id = i.product_id
  or (i.product_id is null and i.marketplace::text = '動作品Amazon返品' and p.asin = i.asin)
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','返品処理','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;
