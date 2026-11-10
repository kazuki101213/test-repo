-- Keep assignees with inventory history even when all displayed status counts are zero.
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
  count(*) filter (where i.bucket = '手元不良') as defective_on_hand
from app.staff s left join app.v_deliverer_stock_workload_items i on i.deliverer_id = s.id
where (select app.management_reports_allowed()) and s.is_active
  and (s.role = 'deliverer' or exists (select 1 from app.items history where history.deliverer_id = s.id))
group by s.id, s.name;
