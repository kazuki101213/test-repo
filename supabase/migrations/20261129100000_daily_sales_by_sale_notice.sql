-- 日別売上を「売れました」通知の時点で集計する（2026-11-29 ユーザー指示）。
-- ・通知のときに実際の売値を記録する（Amazon：注文の単価、メルカリ・ヤフオク：取引画面の金額）。
-- ・取引中の利益は、売値から見込みの入金額を出し、仕入値を引いた見込み。販売済になったら実際の値。
-- ・既存の集計（read_dashboard_daily_sales ほか）は変えない。新しい関数を追加するだけ。

alter table app.sale_notices add column if not exists sale_price bigint
  check (sale_price is null or sale_price between 1 and 999999999);
alter table app.seller_listings add column if not exists trade_price bigint
  check (trade_price is null or trade_price between 1 and 999999999);

-- 価格付きの通知。既存の3引数版はそのまま使い、売値だけ追記する（すでにある通知にも、空なら入れる）。
create or replace function app.record_sale_notice(p_key text, p_item uuid, p_message text, p_price bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare created boolean;
begin
  created := app.record_sale_notice(p_key, p_item, p_message);
  if p_price between 1 and 999999999 then
    update app.sale_notices set sale_price = p_price where source_key = p_key and sale_price is null;
  end if;
  return created;
end $$;
revoke all on function app.record_sale_notice(text, uuid, text, bigint) from public, anon, authenticated;

-- Amazon：注文の単価を通知に記録する。
do $$
declare d text; old_text text := 'left(coalesce(item.title,r.product_title,''''),100),item_price)) then queued';
begin
  d := pg_get_functiondef('app.record_amazon_sale_page(text,uuid,jsonb)'::regprocedure);
  if position(old_text in d) = 0 then raise exception 'record_amazon_sale_page has changed'; end if;
  d := replace(d, old_text, 'left(coalesce(item.title,r.product_title,''''),100),item_price),case when r.amount>0 then r.amount::bigint end) then queued');
  execute d;
end $$;

-- メルカリ・ヤフオク：拡張機能が送る取引画面の金額（trade_price）を出品の記録に残す。
do $$
declare d text; old_text text := 'trade_key=coalesce(trade,trade_key),trade_url=';
begin
  d := pg_get_functiondef('app.sync_seller_observation(text,jsonb)'::regprocedure);
  if position(old_text in d) = 0 then raise exception 'sync_seller_observation has changed'; end if;
  d := replace(d, old_text, 'trade_key=coalesce(trade,trade_key),'
    || 'trade_price=case when coalesce(p_observation->>''trade_price'','''')~''^[0-9]{1,9}$'' and (p_observation->>''trade_price'')::bigint>0 '
    || 'then (p_observation->>''trade_price'')::bigint else trade_price end,trade_url=');
  execute d;
end $$;

-- メルカリ・ヤフオクの通知に売値を記録する（販売済の確定額、なければ取引画面の金額）。
do $$
declare d text;
  old_amount text := 'amount := new.verified_sale->>''sold_price'';';
  old_call text := '''円'' end));';
begin
  d := pg_get_functiondef('app.observe_fleamarket_sale_notice()'::regprocedure);
  if position(old_amount in d) = 0 or position(old_call in d) = 0 then raise exception 'observe_fleamarket_sale_notice has changed'; end if;
  d := replace(d, old_amount, 'amount := coalesce(new.verified_sale->>''sold_price'', new.trade_price::text);');
  d := replace(d, old_call, '''円'' end),case when amount ~ ''^[0-9]{1,9}$'' then amount::bigint end);');
  execute d;
end $$;

-- 取引中の見込みの入金額（売値から計算）。
create or replace function app.dashboard_notice_payout(item app.items, p_price bigint)
returns bigint language plpgsql stable set search_path = '' as $$
declare delivery_size text; postal boolean := false; postage bigint := 0; family text;
begin
  if p_price is null or p_price <= 0 then return null; end if;
  family := app.sales_channel_family(item.sales_channel)::text;
  if family = 'ヤフオク' then return p_price - p_price / 10; end if;
  if family = 'メルカリ' then
    if coalesce(item.shipping_cost, 0) > 0 then
      postage := item.shipping_cost;
    else
      select case p.shipping_category when 'ブ' then '100' when 'モ' then '140' else p.shipping_size end
      into delivery_size from app.products p
      where p.id = item.product_id or (item.product_id is null and p.asin = item.asin)
      order by (p.id = item.product_id) desc, p.id limit 1;
      if delivery_size is null then
        delivery_size := case item.description_template::text
          when 'ブルーレイレコーダー' then '100' when 'モニター' then '140' when 'テレビ' then '140' end;
      end if;
      select coalesce(s.name ~ '吉光|コエル', false) into postal from app.staff s where s.id = item.deliverer_id;
      postage := case delivery_size
        when 'ネコポス' then 210 when '宅急便コンパクト' then 450
        when 'ゆうパケット' then 230 when 'ゆうパケットポスト' then 215
        when 'ゆうパケットポストmini' then 160 when 'ゆうパケットプラス' then 455
        when '60' then 750 when '80' then case when postal then 870 else 850 end
        when '100' then case when postal then 1070 else 1050 end
        when '120' then 1200 when '140' then 1450 when '160' then 1700
        when '170' then 1900 when '180' then 2100 when '200' then 2500 else 0 end;
    end if;
    return p_price - p_price / 10 - postage;
  end if;
  -- Amazon（FBA・自己発送）：出品時の予定価格と予定入金額の比率で見込む。
  if coalesce(item.planned_price, 0) > 0 and coalesce(item.planned_payout, 0) > 0 then
    return round(p_price::numeric * item.planned_payout / item.planned_price)::bigint;
  end if;
  return round(p_price * 0.85)::bigint;
end $$;
revoke all on function app.dashboard_notice_payout(app.items, bigint) from public, anon, authenticated;

-- 日別売上・利益（通知の日で集計）。通知がない販売（11/17以前など）は、これまでどおり販売日で数える。
create or replace function app.read_dashboard_daily_sales_by_notice(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(app.management_reports_allowed(), false) then
    raise exception '管理者でログインしてください。' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from + 1 > 36600 then
    raise exception '開始日・終了日を確認してください。期間は100年以内で指定してください。' using errcode = '22023';
  end if;
  return (
    with notices as materialized (
      select distinct on (n.item_id) n.item_id, n.sale_price, (n.created_at at time zone 'Asia/Tokyo')::date notice_day
      from app.sale_notices n where n.item_id is not null
      order by n.item_id, n.created_at
    ), notice_events as (
      -- 通知が来た商品：取引中は記録した売値と見込みの利益、販売済は実際の売値と利益。キャンセル等は数えない。
      select i.id, n.notice_day as event_day, i.purchaser_id,
        case when i.status = '販売済' then s.sold_price else n.sale_price end amount,
        case when i.status = '販売済' then s.profit
          else app.dashboard_notice_payout(i, n.sale_price) - coalesce(f.family_cost, i.cost_amount, 0) end profit,
        i.status = '取引中' estimated
      from notices n join app.items i on i.id = n.item_id
      left join lateral (select v.sold_price, v.profit from app.v_financial_sales v
        where v.id = i.id order by v.sold_on desc limit 1) s on true
      left join app.v_financial_members m on m.id = i.id
      left join app.v_financial_families f on f.family_key = m.family_key
      where i.status = '取引中'
         or (i.status = '販売済' and not (coalesce(i.sold_price, 0) = 0 and coalesce(i.payout_amount, 0) = 0))
    ), dated_sales as (
      -- 通知がない販売：これまでどおり販売済の販売日。本体と付属品は同じ商品番号・同じ販売日で1件にまとめる。
      select s.id, s.sold_on, s.sold_price, s.payout_amount, s.profit, s.is_accessory, s.family_key, i.purchaser_id,
        upper(coalesce(substring(s.sku from '^([0-9]+[a-zA-Z]*)[-_]'), s.lot_seq::text)) chart_serial
      from app.v_financial_sales s left join app.items i on i.id = s.id
      where s.sold_on is not null
        and not exists (select 1 from notice_events e where e.id = s.id)
        and not exists (select 1 from notices n where n.item_id = coalesce(i.parent_item_id, s.id))
        and (nullif(s.family_key, '') is not null
          or not (s.is_accessory and coalesce(s.sold_price, 0) = 0 and coalesce(s.payout_amount, 0) = 0))
    ), dated_groups as (
      select chart_serial, sold_on,
        count(distinct jsonb_build_array(sold_price, payout_amount)) > 1 or bool_or(sold_price is null) conflict,
        (array_agg(id order by is_accessory, id))[1] chosen_id
      from dated_sales group by chart_serial, sold_on
    ), events as (
      select e.event_day, e.amount, e.profit, e.purchaser_id, e.estimated, e.amount is null missing, false conflict, null::text serial
      from notice_events e
      union all
      select g.sold_on, d.sold_price, d.profit, d.purchaser_id, false, false, g.conflict, g.chart_serial
      from dated_groups g join dated_sales d on d.id = g.chosen_id
    ), scopes(scope) as (values ('all'), ('mine')), scoped as (
      select scopes.scope, e.* from events e cross join scopes
      where e.event_day between p_from and p_to
        and (scopes.scope = 'all' or e.purchaser_id = any((select app.dashboard_purchaser_ids())::uuid[]))
    ), totals as (
      select scope, event_day, sum(coalesce(amount, 0)) amount, sum(coalesce(profit, 0)) profit, count(*) count,
        count(*) filter (where estimated) estimated, count(*) filter (where missing) missing
      from scoped where not conflict group by scope, event_day
    ), days as (
      select scopes.scope, d::date as date, coalesce(t.amount, 0) amount, coalesce(t.profit, 0) profit,
        coalesce(t.count, 0) count, coalesce(t.estimated, 0) estimated, coalesce(t.missing, 0) missing
      from scopes cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
      left join totals t on t.scope = scopes.scope and t.event_day = d::date
    )
    select jsonb_object_agg(scope, jsonb_build_object(
      'days', (select jsonb_agg(jsonb_build_object('date', date, 'amount', amount, 'profit', profit, 'count', count,
          'estimated', estimated, 'missing', missing) order by date) from days d where d.scope = scopes.scope),
      'conflicts', coalesce((select jsonb_agg(distinct s.serial) from scoped s where s.scope = scopes.scope and s.conflict), '[]'::jsonb)
    )) from scopes
  );
end $$;
revoke all on function app.read_dashboard_daily_sales_by_notice(date, date) from public, anon;
grant execute on function app.read_dashboard_daily_sales_by_notice(date, date) to authenticated;
