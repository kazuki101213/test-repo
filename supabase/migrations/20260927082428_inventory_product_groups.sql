create or replace view app.v_product_groups with (security_invoker = true) as
with grouped as (
  select lot_seq, count(*)::integer as product_row_count, sum(cost_amount)::bigint as product_cost,
    count(*) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))::integer as sale_row_count,
    count(distinct (sold_on,sold_price,payout_amount)) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as signatures,
    bool_or(sold_on is not null and sold_price is null and not is_accessory) as missing_price,
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
grant select on app.v_product_groups to authenticated,service_role;
create or replace view app.v_inventory_items with (security_invoker = true) as
select i.*,g.product_row_count,g.product_cost,g.sale_row_count,g.product_sale_conflict,
  g.product_sold_on,g.product_sold_price,g.product_payout_amount
from app.v_items i join app.v_product_groups g using(lot_seq);
grant select on app.v_inventory_items to authenticated;
create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then return new; end if;
  perform pg_advisory_xact_lock(179049,new.lot_seq);
  if exists(select 1 from app.items i where i.lot_seq=new.lot_seq and i.id<>new.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    raise exception '同じ通番号の商品に販売記録があります。売上を重複登録できません。';
  end if;
  return new;
end; $$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;
create trigger items_single_product_sale before insert or update of sold_on,sold_price,payout_amount on app.items
for each row execute function app.guard_single_product_sale();
