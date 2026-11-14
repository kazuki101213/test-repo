begin;
insert into auth.users(id, email) values
  ('99772000-0000-0000-0000-000000000002', 'dashboard-other-admin@example.invalid'),
  ('99772000-0000-0000-0000-000000000003', 'dashboard-purchaser@example.invalid');
insert into app.staff(code, name, role, is_active) values ('ZX', 'Dashboard test admin', 'admin', true);
insert into app.profiles(user_id, staff_id)
select settings.user_id::uuid, s.id from app.staff s
join (values
  ('ZX', '99772000-0000-0000-0000-000000000002'),
  ('EE', '99772000-0000-0000-0000-000000000003')
) settings(code, user_id) using (code);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into app.items (sku, lot_seq, title, purchaser_id, deliverer_id, purchased_at, cost_amount,
  marketplace, sales_channel, status, sold_on, sold_price, payout_amount, planned_payout)
select v.sku, v.lot, v.sku, p.id, d.id, '2089-01-01', v.cost, 'ヤフオク', 'ヤフオク',
  v.status::app.item_status, v.sold_on::date, v.sold_price, v.payout, v.planned
from (values
  ('997720-AADD-20890101-30', 997720, 'AA', 300, '販売済', '2089-01-02', 1500, 1200, 1200),
  ('997721-EEDD-20890101-60', 997721, 'EE', 600, '販売済', '2089-01-02', 2500, 2000, 2000),
  ('997722-ZXDD-20890101-90', 997722, 'ZX', 900, '販売済', '2089-01-03', 4500, 4100, 4100),
  ('997723-EEDD-20890101-60', 997723, 'EE', 600, '受取前', null, null, null, 1300),
  ('997724-ZXDD-20890101-45', 997724, 'ZX', 450, '受取前', null, null, null, 900)
) v(sku, lot, buyer, cost, status, sold_on, sold_price, payout, planned)
join app.staff p on p.code = v.buyer
cross join app.staff d where d.code = 'DD';

do $$
declare
  result jsonb := app.read_dashboard_purchaser_summary();
  monthly jsonb;
  chart jsonb := app.read_dashboard_daily_sales('2089-01-01', '2089-01-04');
begin
  select m into monthly from jsonb_array_elements(result->'months') m where m->>'month' = '2089-01-01';
  if (monthly->>'仕入数')::int is distinct from 3 or (monthly->>'仕入金額')::int is distinct from 1500
    or (monthly->>'販売数')::int is distinct from 2 or (monthly->>'売上')::int is distinct from 4000 then
    raise exception 'AA must see AA + EE in the monthly trend: %', monthly;
  end if;
  if (select count(*) from app.v_dashboard_purchaser_purchases where lot_seq between 997720 and 997724) <> 3
    or (select count(*) from app.v_dashboard_purchaser_sales where lot_seq between 997720 and 997724) <> 2
    or (select count(*) from app.v_dashboard_purchaser_workload_items where lot_seq between 997720 and 997724) <> 1 then
    raise exception 'Purchaser drilldowns do not match the report scope';
  end if;
  if not exists (select 1 from jsonb_array_elements(result->'workload') w
    where (w->>'deliverer_id')::uuid = (select id from app.staff where code = 'DD') and (w->>'awaiting_receipt')::int >= 1) then
    raise exception 'Attributed inventory missing from workload';
  end if;
  if (result->'stock'->>'売上見込み合計')::int < 1300 then raise exception 'Attributed inventory missing from stock'; end if;
  if chart->'all' is distinct from app.read_daily_sales_summary('2089-01-01', '2089-01-04') then
    raise exception 'Existing daily totals changed';
  end if;
  if chart->'mine'->'days' is distinct from '[
    {"date":"2089-01-01","amount":0,"count":0},{"date":"2089-01-02","amount":4000,"count":2},
    {"date":"2089-01-03","amount":0,"count":0},{"date":"2089-01-04","amount":0,"count":0}
  ]'::jsonb then
    raise exception 'Attributed daily series differs: %', chart;
  end if;
end $$;

set local request.jwt.claim.sub = '99772000-0000-0000-0000-000000000002';
do $$
declare
  result jsonb := app.read_dashboard_purchaser_summary();
  monthly jsonb;
begin
  select m into monthly from jsonb_array_elements(result->'months') m where m->>'month' = '2089-01-01';
  if (monthly->>'仕入数')::int is distinct from 2 or (monthly->>'売上')::int is distinct from 4500
    or (result->'stock'->>'売上見込み合計')::int is distinct from 900 then
    raise exception 'Second admin must see only their assignments: %', result;
  end if;
end $$;

set local request.jwt.claim.sub = '99772000-0000-0000-0000-000000000003';
do $$
begin
  if exists(select 1 from app.v_dashboard_purchaser_purchases) or exists(select 1 from app.v_dashboard_purchaser_expenses) then
    raise exception 'Purchaser can see management drilldowns';
  end if;
  begin
    perform app.read_dashboard_purchaser_summary();
    raise exception 'Purchaser can see management summary';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app.read_dashboard_daily_sales('2089-01-01', '2089-01-04');
    raise exception 'Purchaser can see management daily summary';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
