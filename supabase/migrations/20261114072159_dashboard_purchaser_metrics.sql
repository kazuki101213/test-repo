-- Purchaser attribution applies only to dashboard reporting.
create function app.dashboard_purchaser_ids() returns uuid[]
language sql stable security invoker set search_path = '' as $$
  with attribution(source_code, owner_code) as (values ('EE', 'AA'))
  select coalesce(array_agg(source.id), '{}'::uuid[])
  from app.staff viewer
  join app.staff source on source.id = viewer.id or exists (
    select 1 from attribution where source_code = source.code and owner_code = viewer.code
  )
  where viewer.id = app.current_staff_id() and app.management_reports_allowed()
    and not exists (
      select 1 from attribution where source_code = source.code and owner_code <> viewer.code
    );
$$;

create view app.v_dashboard_purchaser_purchases
with (security_invoker = true, security_barrier = true) as
select id, lot_seq, sku, is_accessory, title, marketplace, purchased_at, sold_on,
  cost_amount, sold_price, payout_amount, refund_amount, profit, shipping_cost, other_cost
from app.items
where purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[]);

create view app.v_dashboard_purchaser_sales
with (security_invoker = true, security_barrier = true) as
select s.*
from app.v_financial_sales s
join app.items i on i.id = s.id
where i.purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[]);

create view app.v_dashboard_purchaser_expenses
with (security_invoker = true, security_barrier = true) as
select id, incurred_on, category, name, amount, card_id, staff_id, memo, deleted_at
from app.expenses
where (select app.management_reports_allowed()) and staff_id = (select app.current_staff_id());

create view app.v_dashboard_purchaser_workload_items
with (security_invoker = true, security_barrier = true) as
select w.*
from app.v_deliverer_stock_workload_items w
join app.items i on i.id = w.id
where i.purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[]);

create function app.read_dashboard_purchaser_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not coalesce(app.management_reports_allowed(), false) then
    raise exception '管理者でログインしてください。' using errcode = '42501';
  end if;
  return (
    with purchases as (
      select date_trunc('month', purchased_at::timestamp)::date as month,
        count(*) "仕入数", sum(cost_amount) "仕入金額"
      from app.v_dashboard_purchaser_purchases where purchased_at is not null group by 1
    ), sales as (
      select date_trunc('month', sold_on::timestamp)::date as month,
        count(distinct family_key) "販売数", sum(sold_price) "売上",
        sum(payout_amount) "振込金額", sum(profit) "粗利益"
      from app.v_dashboard_purchaser_sales where sold_on is not null group by 1
    ), expenses as (
      select date_trunc('month', incurred_on::timestamp)::date as month, sum(amount) "経費"
      from app.v_dashboard_purchaser_expenses where deleted_at is null group by 1
    ), monthly as (
      select coalesce(p.month, s.month, e.month) as month,
        coalesce(p."仕入数", 0) "仕入数", coalesce(p."仕入金額", 0) "仕入金額",
        coalesce(s."販売数", 0) "販売数", coalesce(s."売上", 0) "売上",
        coalesce(s."振込金額", 0) "振込金額", coalesce(s."粗利益", 0) "粗利益",
        coalesce(e."経費", 0) "経費", coalesce(s."粗利益", 0) - coalesce(e."経費", 0) "純利益"
      from purchases p full join sales s using (month)
      full join expenses e on e.month = coalesce(p.month, s.month)
    ), current_items as (
      -- Choose the current row across purchasers before applying ownership.
      select distinct on (app.financial_product_serial(i.sku, i.lot_seq))
        app.financial_product_serial(i.sku, i.lot_seq) family_key, i.purchaser_id, i.planned_payout
      from app.items i
      where not i.is_accessory and i.sold_on is null
        and i.status in ('受取前', '検品中', 'Amazon返送依頼', 'Amazon補填申請中', '商品登録前', '動作不良')
      order by family_key, i.purchased_at desc nulls last, i.created_at desc, i.id
    ), realized as (
      select family_key, sum(profit) profit, sum(cost_amount) allocated_cost
      from app.v_financial_sales group by family_key
    ), stock as (
      select count(*) "現在庫数", coalesce(sum(i.planned_payout), 0) "売上見込み合計",
        coalesce(sum(coalesce(i.planned_payout, 0)::numeric + coalesce(r.profit, 0)
          - f.family_cost + coalesce(r.allocated_cost, 0)), 0) "見込み利益合計"
      from current_items i
      join app.v_financial_families f using (family_key)
      left join realized r using (family_key)
      where i.purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[])
    ), workload as (
      select deliverer_id, count(*) filter (where on_hand) on_hand,
        count(*) filter (where bucket = '受取前') awaiting_receipt,
        count(*) filter (where bucket = '検品中') inspecting,
        count(*) filter (where bucket = 'Amazon返品') amazon_returns,
        count(*) filter (where bucket = '登録前') awaiting_registration,
        count(*) filter (where bucket = '手元出品') listed_on_hand,
        count(*) filter (where bucket = 'FBA出品') listed_in_fba,
        count(*) filter (where bucket = '発送前') trading_unshipped,
        count(*) filter (where bucket = '発送済み') trading_shipped,
        count(*) filter (where bucket = '手元不良') defective_on_hand
      from app.v_dashboard_purchaser_workload_items group by deliverer_id
    )
    select jsonb_build_object(
      'stock', (select to_jsonb(stock) from stock),
      'months', coalesce((select jsonb_agg(to_jsonb(m) order by m.month desc) from monthly m), '[]'::jsonb),
      'workload', coalesce((select jsonb_agg(to_jsonb(w)) from workload w), '[]'::jsonb)
    )
  );
end;
$$;

-- Keep the existing daily report available to its callers. The dashboard uses the
-- same conflict resolution and selects the purchaser of the canonical sale row.
create function app.read_dashboard_daily_sales(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not coalesce(app.management_reports_allowed(), false) then
    raise exception '管理者でログインしてください。' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from + 1 > 36600 then
    raise exception '開始日・終了日を確認してください。期間は100年以内で指定してください。' using errcode = '22023';
  end if;
  return (
    with sales as materialized (
      select s.id, s.sold_on, s.sold_price, s.payout_amount, s.is_accessory, s.family_key, i.purchaser_id,
        upper(coalesce(substring(s.sku from '^([0-9]+[a-zA-Z]*)[-_]'), s.lot_seq::text)) chart_serial
      from app.v_financial_sales s
      left join app.items i on i.id = s.id
      where s.sold_on is not null and (nullif(s.family_key, '') is not null
        or not (s.is_accessory and coalesce(s.sold_price, 0) = 0 and coalesce(s.payout_amount, 0) = 0))
    ), grouped as (
      select chart_serial, (array_agg(family_key order by id))[1] family,
        count(distinct jsonb_build_array(sold_on, sold_price, payout_amount)) > 1 or bool_or(sold_price is null) conflict
      from sales group by chart_serial
    ), chosen as (
      select distinct on (chart_serial) chart_serial, sold_on, sold_price, purchaser_id
      from sales order by chart_serial, is_accessory, id
    ), scopes(scope) as (values ('all'), ('mine')), totals as (
      select scope, c.sold_on, sum(coalesce(c.sold_price, 0)) amount,
        count(distinct coalesce(g.family, g.chart_serial)) count
      from chosen c join grouped g using (chart_serial)
      cross join scopes
      where not g.conflict and c.sold_on between p_from and p_to
        and (scope = 'all' or c.purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[]))
      group by scope, c.sold_on
    ), days as (
      select scopes.scope, d::date as date, coalesce(t.amount, 0) amount, coalesce(t.count, 0) count
      from scopes cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
      left join totals t on t.scope = scopes.scope and t.sold_on = d::date
    ), conflicts as (
      select scope, g.chart_serial from grouped g cross join scopes
      where g.conflict and exists (
        select 1 from sales s where s.chart_serial = g.chart_serial and s.sold_on between p_from and p_to
          and (scope = 'all' or s.purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[]))
      )
    )
    select jsonb_object_agg(scope, jsonb_build_object(
      'days', (select jsonb_agg(jsonb_build_object('date', date, 'amount', amount, 'count', count) order by date)
        from days d where d.scope = scopes.scope),
      'conflicts', coalesce((select jsonb_agg(chart_serial order by chart_serial)
        from conflicts c where c.scope = scopes.scope), '[]'::jsonb)
    )) from scopes
  );
end;
$$;

revoke all on function app.dashboard_purchaser_ids(), app.read_dashboard_purchaser_summary(),
  app.read_dashboard_daily_sales(date, date) from public, anon;
grant execute on function app.dashboard_purchaser_ids(), app.read_dashboard_purchaser_summary(),
  app.read_dashboard_daily_sales(date, date) to authenticated;
revoke all on app.v_dashboard_purchaser_purchases, app.v_dashboard_purchaser_sales, app.v_dashboard_purchaser_expenses,
  app.v_dashboard_purchaser_workload_items from public, anon, authenticated;
grant select on app.v_dashboard_purchaser_purchases, app.v_dashboard_purchaser_sales, app.v_dashboard_purchaser_expenses,
  app.v_dashboard_purchaser_workload_items to authenticated;

notify pgrst, 'reload schema';
