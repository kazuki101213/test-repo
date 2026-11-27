-- 2026-11-27 ダッシュボードの statement timeout 対策（結果は変えずに読み込みを軽くする）
-- 1) read_resource_snapshot('malfunctions')：仕入先返金待ちの確認（supplier_refund_wait_event）を全商品（約3,500件）で毎回呼んでいた。
--    返金待ちになりうる商品（workflow_decision='yahoo' で解決済み、または「返品処理」）だけ CASE で先に絞る。0.48秒→0.02秒。
--    権限の確認（is_admin 等）も1件ごとではなく1回だけにする。
-- 2) v_delivery_tasks：付属品だけに使う shared_product_sale_values を全商品で呼んでいた → 付属品の行だけ呼ぶ。
--    権限の確認 is_admin()/current_staff_id() を1回だけにする（scalar subquery）。結果は同一（配送担当3人で md5 一致を確認）。
do $migration$
declare
  d text; nd text;
begin
  d := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  nd := replace(d,
$old$      left join lateral (
        select app.supplier_refund_wait_event(i) as return_event_id
        where i.non_amazon_refund_amount=0
      ) decision on true$old$,
$new$      left join lateral (
        select case when i.non_amazon_refund_amount=0
          and ((i.workflow_decision='yahoo' and i.malfunction_resolved_at>=i.malfunction_reported_at) or i.status='返品処理')
          then app.supplier_refund_wait_event(i) end as return_event_id
      ) decision on true$new$);
  nd := replace(nd,
$old$      where (app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))$old$,
$new$      where ((select app.is_admin()) or ((select app.current_role())='purchaser' and i.purchaser_id=(select app.current_staff_id())))$new$);
  if position('then app.supplier_refund_wait_event(i) end as return_event_id' in nd) = 0
     or position('where ((select app.is_admin())' in nd) = 0 then
    raise exception 'read_resource_snapshot の置き換え箇所が見つかりません';
  end if;
  execute nd;

  d := rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass, true), ';');
  nd := replace(d,
    'LEFT JOIN LATERAL app.shared_product_sale_values(i_1_1_1.id) shared(sales_channel, sold_price, payout_amount) ON true',
    'LEFT JOIN LATERAL ( SELECT s_1.sales_channel, s_1.sold_price, s_1.payout_amount FROM app.shared_product_sale_values(i_1_1_1.id) s_1(sales_channel, sold_price, payout_amount) WHERE i_1_1_1.is_accessory) shared ON true');
  nd := replace(nd,
    'WHERE app.is_admin() OR i_1_1_1.deliverer_id = app.current_staff_id()',
    'WHERE ( SELECT app.is_admin() AS is_admin) OR i_1_1_1.deliverer_id = ( SELECT app.current_staff_id() AS current_staff_id)');
  if position('WHERE i_1_1_1.is_accessory) shared ON true' in nd) = 0
     or position('( SELECT app.is_admin() AS is_admin)' in nd) = 0 then
    raise exception 'v_delivery_tasks の置き換え箇所が見つかりません';
  end if;
  execute 'create or replace view app.v_delivery_tasks with (security_invoker = true) as ' || nd;
end
$migration$;
