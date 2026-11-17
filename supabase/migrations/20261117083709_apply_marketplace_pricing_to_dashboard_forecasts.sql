-- Forecast the same item price used by the Mercari and Yahoo Auctions listing drafts.
create function app.dashboard_expected_payout(item app.items)
returns bigint
language plpgsql stable security invoker
set search_path = ''
as $forecast$
declare
  proposed_price bigint;
  delivery_size text;
  postal boolean := false;
  postage bigint := 0;
begin
  if item.sales_channel not in ('メルカリ', 'ヤフオク') or item.sales_channel is null
    or item.sold_on is not null or coalesce(item.planned_price, 0) <= 0 then
    return item.planned_payout;
  end if;

  proposed_price := ceil(item.planned_price::numeric * case
    when item.sales_channel = 'メルカリ' then 0.80
    when item.condition = '可' then 0.20
    else 0.35 end)::bigint;

  if item.sales_channel = 'メルカリ' then
    if coalesce(item.shipping_cost, 0) > 0 then
      postage := item.shipping_cost;
    else
      select case p.shipping_category when 'ブ' then '100' when 'モ' then '140' else p.shipping_size end
      into delivery_size
      from app.products p
      where p.id = item.product_id or (item.product_id is null and p.asin = item.asin)
      order by (p.id = item.product_id) desc, p.id limit 1;

      if delivery_size is null then
        delivery_size := case item.description_template::text
          when 'ブルーレイレコーダー' then '100'
          when 'モニター' then '140' when 'テレビ' then '140' end;
      end if;
      select coalesce(s.name ~ '吉光|コエル', false) into postal
      from app.staff s where s.id = item.deliverer_id;
      -- Mercari charges the actual package size. Its broad labels on the
      -- shipping screen represent groups of sizes, not a single tariff.
      postage := case delivery_size
        when 'ネコポス' then 210 when '宅急便コンパクト' then 450
        when 'ゆうパケット' then 230 when 'ゆうパケットポスト' then 215
        when 'ゆうパケットポストmini' then 160 when 'ゆうパケットプラス' then 455
        when '60' then 750 when '80' then case when postal then 870 else 850 end
        when '100' then case when postal then 1070 else 1050 end
        when '120' then 1200 when '140' then 1450 when '160' then 1700
        when '170' then 1900 when '180' then 2100 when '200' then 2500
        else 0 end;
    end if;
  end if;

  return proposed_price - proposed_price / 10 - postage;
end
$forecast$;
revoke all on function app.dashboard_expected_payout(app.items) from public, anon;
grant execute on function app.dashboard_expected_payout(app.items) to authenticated;

create or replace view app.v_stock_summary as
with current_items as (
  select distinct on (app.financial_product_serial(i.sku, i.lot_seq))
    i.purchased_at, app.dashboard_expected_payout(i) as planned_payout,
    app.financial_product_serial(i.sku,i.lot_seq) as family_key
  from app.items i
  where not i.is_accessory and i.sold_on is null
    and i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良')
  order by app.financial_product_serial(i.sku,i.lot_seq),
    i.purchased_at desc nulls last, i.created_at desc, i.id
), realized as (
  select family_key,sum(profit) as profit,sum(cost_amount) as allocated_cost
  from app.v_financial_sales group by family_key
)
select count(*) as "現在庫数", coalesce(sum(f.family_cost),0)::numeric as "仕入金額合計",
  coalesce(sum(coalesce(i.planned_payout,0)),0)::numeric as "売上見込み合計",
  coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,0)-f.family_cost
    +coalesce(realized.allocated_cost,0)),0)::numeric as "見込み利益合計",
  count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
  count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
  count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
  count(*) as "保有在庫", count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using (family_key)
left join realized using (family_key)
having (select app.management_reports_allowed());

do $migration$
declare
  definition text := pg_get_functiondef('app.read_dashboard_purchaser_summary()'::regprocedure);
  updated text;
begin
  updated := replace(definition,
    'family_key, i.purchaser_id, i.planned_payout',
    'family_key, i.purchaser_id, app.dashboard_expected_payout(i) as planned_payout');
  if updated = definition then
    raise exception 'Stock for the current purchaser was not found';
  end if;
  execute updated;
end $migration$;

create or replace function app.read_dashboard_purchase_forecast(p_month date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $forecast$
declare
  purchaser_ids uuid[];
begin
  if not coalesce(app.management_reports_allowed(), false) then
    raise exception '閲覧する権限がありません' using errcode = '42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception '対象月を確認してください' using errcode = '22023';
  end if;

  purchaser_ids := app.dashboard_purchaser_ids();
  return (
    with forecasts as (
      select i.purchaser_id,
        case when i.sales_channel in ('メルカリ', 'ヤフオク') and i.sold_on is null
          and coalesce(i.planned_price, 0) > 0
        then coalesce(v.expected_profit, -f.family_cost) - coalesce(i.planned_payout, 0)
          + app.dashboard_expected_payout(i)
        else v.expected_profit end as profit
      from app.v_financial_families f
      join app.items i on i.id = f.origin_item_id
      join app.v_inventory_display v on v.id = i.id
      where f.origin_purchased_at >= p_month and f.origin_purchased_at < p_month + interval '1 month'
    )
    select jsonb_build_object('all', coalesce(sum(profit), 0),
      'mine', coalesce(sum(profit) filter (where purchaser_id = any(purchaser_ids)), 0))
    from forecasts
  );
end
$forecast$;
notify pgrst, 'reload schema';
