-- Read as the logged-in user and restrict delivery inventory to their assignment.
-- Administrators retain the existing all-staff overview.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
SELECT i.id,
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
        CASE
            WHEN i.is_accessory THEN shared.sales_channel
            ELSE i.sales_channel
        END AS sales_channel,
    i.planned_price,
    i.deliverer_id,
    buyer.name AS purchaser_name,
    i.product_registered_at IS NOT NULL AS product_registered,
    i.inspected_at IS NOT NULL AS inspected,
    i.photo_uploaded_at IS NOT NULL AS photo_uploaded,
    i.packed_on,
    i.shipped_on,
    i.amazon_returned_on,
    COALESCE(NULLIF(btrim(p.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS reference_image_url,
    ( SELECT count(*) AS count
           FROM app.item_photos ph
          WHERE ph.item_id = i.id) AS photo_count,
    ( SELECT max(cm.created_at) AS max
           FROM app.item_comments cm
          WHERE cm.item_id = i.id) AS last_comment_at,
    i.cleaned_at IS NOT NULL AS cleaned,
    i.description_template,
    i.manufacture_year,
    i.marketplace_item_id,
    p.model_no,
    i.malfunction_reported,
    i.malfunction_comment,
    i.malfunction_reported_at,
    i.malfunction_resolved_at,
        CASE
            WHEN i.is_accessory THEN shared.sold_price
            ELSE i.sold_price
        END AS sold_price,
        CASE
            WHEN i.is_accessory THEN shared.payout_amount
            ELSE i.payout_amount
        END AS payout_amount,
    i.marketplace_url
   FROM app.items i
     LEFT JOIN app.products p ON p.id = i.product_id OR i.product_id IS NULL AND i.marketplace::text = '動作品Amazon返品'::text AND p.asin = i.asin
     LEFT JOIN app.products asin_product ON asin_product.asin = i.asin
     LEFT JOIN app.staff buyer ON buyer.id = i.purchaser_id
     LEFT JOIN LATERAL app.shared_product_sale_values(i.id) shared(sales_channel, sold_price, payout_amount) ON true
  WHERE i.status = ANY (ARRAY['作業中'::app.item_status, '返品処理'::app.item_status, '出品中'::app.item_status, '販売済'::app.item_status]) AND (app.is_admin() OR i.deliverer_id = app.current_staff_id());
notify pgrst, 'reload schema';
