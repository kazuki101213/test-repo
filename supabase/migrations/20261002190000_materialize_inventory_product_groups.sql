-- Compute product rollups once per request and join each item through the
-- product-serial index. PostgreSQL otherwise expands both views and may choose
-- a nested-loop join that compares every inventory row with every product group.
create or replace view app.v_inventory_items with (security_invoker = true) as
with groups as materialized (
  select * from app.v_product_groups
)
select i.*,g.product_row_count,g.product_cost,g.sale_row_count,g.product_sale_conflict,
  g.product_sold_on,g.product_sold_price,g.product_payout_amount
from app.v_items i
join groups g on g.serial_key=app.product_serial(i.sku,i.lot_seq);

grant select on app.v_inventory_items to authenticated;
