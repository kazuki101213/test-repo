-- Speed up the per-product rollups used by the inventory display view.
-- Without this expression index, each displayed item scans all inventory rows
-- to find its product siblings, which makes the page time out as data grows.
create index if not exists items_product_serial_financial_idx
  on app.items (app.product_serial(sku, lot_seq))
  include (refund_amount, inventory_refund_amount, shipping_cost, other_cost);
