create or replace view app.v_product_groups with (security_invoker = true) as
with grouped as (
  select lot_seq, count(*)::integer as product_row_count, sum(cost_amount)::bigint as product_cost,
    count(*) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))::integer as sale_row_count,
    count(distinct (sold_on,sold_price,payout_amount)) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as signatures,
    bool_or(sold_on is not null and sold_price is null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as missing_price,
    min(sold_on) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_date,
    max(sold_price) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_price,
    max(payout_amount) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_payout
  from app.items group by lot_seq
)
select lot_seq,product_row_count,product_cost,sale_row_count,
  (signatures > 1 or coalesce(missing_price,false)) as product_sale_conflict,
  case when signatures=1 and not coalesce(missing_price,false) then sale_date end as product_sold_on,
  case when signatures=1 and not coalesce(missing_price,false) then sale_price end as product_sold_price,
  case when signatures=1 and not coalesce(missing_price,false) then sale_payout end as product_payout_amount
from grouped;
