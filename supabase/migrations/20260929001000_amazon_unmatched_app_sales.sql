create or replace view app.v_amazon_unmatched_app_sales with (security_invoker=true) as
with amazon_lots as (
  select distinct case
    when canonical_sku ~ '^[0-9]+-' then split_part(canonical_sku,'-',1)::integer
    when canonical_sku ~ '^[0-9]+$' then canonical_sku::integer
    else null end as lot_seq
  from app.v_amazon_order_reconciliation
  where order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and item_price is not null
), sold_products as (
  select lot_seq, min(sold_on) as app_sold_on, max(sold_price) as app_sold_price,
    min(sku) as example_sku, string_agg(distinct sales_channel::text, ', ') as sales_channels,
    count(*) as app_row_count
  from app.items
  where sold_on is not null and sales_channel::text in ('FBA','自己発送') and is_accessory=false
  group by lot_seq
)
select s.* from sold_products s where not exists (select 1 from amazon_lots a where a.lot_seq=s.lot_seq);
grant select on app.v_amazon_unmatched_app_sales to authenticated;
