-- Show Amazon return requests separately from inventory physically on hand.
create or replace view app.v_deliverer_stock_workload_items with (security_invoker = true, security_barrier = true) as
select i.id, i.deliverer_id, i.lot_seq, i.sku, i.title, p.model_no, i.status, i.marketplace,
  i.sales_channel, i.purchased_at, i.packed_on, i.shipped_on, state.bucket,
  coalesce(i.shipped_on is null and not location.left_for_fba and (
    state.bucket in ('登録前', '手元出品', '発送前', '手元不良')
    or (state.bucket = '検品中' and (i.inspected_at is not null or i.cleaned_at is not null))
  ), false) as on_hand
from app.items i
left join app.products p on p.id = i.product_id
left join workload_private.fba_stock_evidence f on f.item_id = i.id and f.sku = i.sku
  and f.account = case when i.sales_channel::text = 'FBA' then 'FBA1' else i.sales_channel::text end
cross join lateral (select
  coalesce(f.received or f.dispatched, false) as left_for_fba,
  i.sales_channel::text in ('自己発送', '自己発送1', '自己発送2', 'メルカリ', 'ヤフオク', 'ヤフフリ') as self_fulfilled
) location
cross join lateral (select case
  when i.status = '受取前' then '受取前'
  when i.status = '検品中' then '検品中'
  when i.status = 'Amazon返送依頼' then 'Amazon返品'
  when i.status = '商品登録前' then '登録前'
  when i.status = '出品中' and location.self_fulfilled and i.shipped_on is null then '手元出品'
  when i.status = '出品中' and f.received then 'FBA出品'
  when i.status = '取引中' and i.shipped_on is not null then '発送済み'
  when i.status = '取引中' and location.self_fulfilled then '発送前'
  when i.status = '動作不良' and i.shipped_on is null and not location.left_for_fba
    and (i.inspected_at is not null or i.cleaned_at is not null or i.malfunction_reported_at is not null) then '手元不良'
end as bucket) state
where (select app.management_reports_allowed()) and not i.is_accessory and i.deliverer_id is not null
  and i.status in ('受取前', '検品中', 'Amazon返送依頼', '商品登録前', '出品中', '取引中', '動作不良');

create or replace view app.v_deliverer_stock_workload with (security_invoker = true, security_barrier = true) as
select s.id as deliverer_id, s.name as deliverer_name,
  count(*) filter (where i.on_hand) as on_hand,
  count(*) filter (where i.bucket = '受取前') as awaiting_receipt,
  count(*) filter (where i.bucket = '検品中') as inspecting,
  count(*) filter (where i.bucket = '登録前') as awaiting_registration,
  count(*) filter (where i.bucket = '手元出品') as listed_on_hand,
  count(*) filter (where i.bucket = 'FBA出品') as listed_in_fba,
  count(*) filter (where i.bucket = '発送前') as trading_unshipped,
  count(*) filter (where i.bucket = '発送済み') as trading_shipped,
  count(*) filter (where i.bucket = '手元不良') as defective_on_hand,
  count(*) filter (where i.bucket = 'Amazon返品') as amazon_returns
from app.staff s left join app.v_deliverer_stock_workload_items i on i.deliverer_id = s.id
where (select app.management_reports_allowed()) and s.is_active
  and (s.role = 'deliverer' or exists (select 1 from app.items history where history.deliverer_id = s.id))
group by s.id, s.name;

notify pgrst, 'reload schema';
