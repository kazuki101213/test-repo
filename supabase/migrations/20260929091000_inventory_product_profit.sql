create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*,
  raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount,
  latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds - inventory.product_cost
      - totals.shipping - totals.other_cost
  end as product_profit
from app.v_inventory_items inventory
join app.items raw on raw.id = inventory.id
left join app.products product on product.id = raw.product_id
left join lateral (
  select body from app.item_comments
  where item_id = inventory.id
  order by created_at desc, id desc limit 1
) latest on true
left join lateral (
  select sum(refund_amount) as refunds, sum(shipping_cost) as shipping,
    sum(other_cost) as other_cost
  from app.items where lot_seq = inventory.lot_seq
) totals on true;
grant select on app.v_inventory_display to authenticated;
