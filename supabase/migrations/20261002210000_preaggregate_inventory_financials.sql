-- The per-row financial rollup in v_inventory_display forces a full RLS-filtered
-- items scan for every item. Aggregate once per statement and join by product key.
create or replace view app.v_inventory_display with (security_invoker = true) as
with totals as materialized (
  select app.product_serial(i.sku, i.lot_seq) as serial_key,
    sum(i.refund_amount) as refunds,
    sum(i.inventory_refund_amount) as inventory_refunds,
    sum(i.shipping_cost) as shipping,
    sum(i.other_cost) as other_cost
  from app.items i
  group by app.product_serial(i.sku, i.lot_seq)
)
select inventory.*, raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds + totals.inventory_refunds
      - inventory.product_cost - totals.shipping - totals.other_cost end as product_profit,
  raw.inventory_refund_amount
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join totals on totals.serial_key=app.product_serial(raw.sku,raw.lot_seq)
left join lateral (
  select body from app.item_comments
  where item_id=inventory.id
  order by created_at desc,id desc
  limit 1
) latest on true;

grant select on app.v_inventory_display to authenticated;
