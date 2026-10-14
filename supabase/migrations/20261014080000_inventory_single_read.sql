-- Return the purchase reference with each inventory row; avoid a second full-table read.
create or replace view app.v_inventory_display as
 WITH financial_totals AS MATERIALIZED (select family_key,sum(profit)::numeric as profit,sum(cost_amount)::numeric as allocated_cost from app.v_financial_sales group by family_key)
 SELECT inventory.id,
    inventory.sku,
    inventory.lot_seq,
    inventory.is_accessory,
    inventory.status,
    inventory.condition,
    inventory.title,
    inventory.asin,
    inventory.model_no,
    inventory.maker,
    inventory.genre,
    inventory.turnover,
    inventory.purchased_at,
    inventory.cost_amount,
    inventory.marketplace,
    inventory.marketplace_url,
    inventory.card_name,
    inventory.purchaser_name,
    inventory.deliverer_name,
    inventory.work_stream,
    inventory.deliverer_id,
    inventory.purchaser_id,
    inventory.tracking_no,
    inventory.planned_price,
    inventory.planned_payout,
    inventory.sales_channel,
    inventory.product_registered,
    inventory.inspected,
    inventory.photo_uploaded,
    inventory.packed_on,
    inventory.shipped_on,
    inventory.listed_on,
    inventory.sold_on,
    inventory.sold_price,
    inventory.payout_amount,
    inventory.amazon_returned_on,
    inventory.refund_amount,
    inventory.profit,
    inventory.days_to_sell,
    inventory.days_in_stock,
    (inventory.planned_payout+coalesce(financial_totals.profit,0)-coalesce(family.family_cost,inventory.product_cost)+coalesce(financial_totals.allocated_cost,0))::bigint AS expected_profit,
    inventory.accessories,
    inventory.memo,
    inventory.updated_at,
    inventory.product_row_count,
    coalesce(family.family_cost,inventory.product_cost)::bigint AS product_cost,
    inventory.sale_row_count,
    inventory.product_sale_conflict,
    inventory.product_sold_on,
    inventory.product_sold_price,
    inventory.product_payout_amount,
    raw.product_id,
    product.product_no,
    COALESCE(NULLIF(btrim(product.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS amazon_image_url,
    raw.amazon_refund_amount,
    raw.non_amazon_refund_amount,
    latest.body AS latest_comment,
        CASE WHEN NOT inventory.product_sale_conflict AND inventory.product_sold_on IS NOT NULL
          THEN financial_totals.profit
          ELSE NULL::numeric END AS product_profit,
    raw.inventory_refund_amount,
    case when (select app.current_role()) in ('admin','purchaser')
      or raw.deliverer_id=(select app.current_staff_id())
      then raw.marketplace_item_id else null end as marketplace_item_id
   FROM app.v_inventory_items inventory
     JOIN app.items raw ON raw.id = inventory.id
     LEFT JOIN app.v_financial_families family ON family.family_key=app.financial_product_serial(raw.sku,raw.lot_seq)
     LEFT JOIN financial_totals ON financial_totals.family_key=family.family_key
     LEFT JOIN app.products product ON product.id = raw.product_id
     LEFT JOIN app.products asin_product ON asin_product.asin = raw.asin
     LEFT JOIN LATERAL ( SELECT item_comments.body
           FROM app.item_comments
          WHERE item_comments.item_id = inventory.id
          ORDER BY item_comments.created_at DESC, item_comments.id DESC
         LIMIT 1) latest ON true;

notify pgrst,'reload schema';
