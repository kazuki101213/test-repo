create or replace view app.v_admin_work_deadlines
with (security_invoker = true, security_barrier = true) as
with candidates as (
  select i.id, i.sku, i.lot_seq, i.sales_channel, i.marketplace,
    i.marketplace_item_id, i.marketplace_url, t.recorded_at, i.status,
    greatest(i.inspected_at, i.malfunction_reported_at) as action_at,
    i.listed_on, app.sales_channel_family(i.sales_channel) as channel,
    i.is_accessory and not app.is_standalone_accessory_serial(i.sku, i.lot_seq) as linked_accessory,
    parent.id as parent_id,
    greatest(parent.inspected_at, parent.malfunction_reported_at) as parent_action_at,
    greatest(i.packed_on, parent.packed_on) as work_completed_on
  from app.items i
  join app.item_tracking_recordings t on t.item_id = i.id
  left join app.items parent on parent.id = i.parent_item_id and not parent.is_accessory
  where (select auth.uid()) is not null and (select app.is_admin())
    and exists (select 1 from app.staff s where s.id = (select app.current_staff_id()) and s.is_active)
    and i.deliverer_id is not null and i.sold_on is null
    and i.status in ('受取前','検品中','商品登録前')
    and nullif(btrim(i.tracking_no), '') is not null
)
select i.id, i.id as item_id, i.sku, i.lot_seq, i.sales_channel, i.marketplace,
  i.marketplace_item_id, i.marketplace_url, i.recorded_at as created_at, 'listing'::text as kind,
  i.id as action_item_id
from candidates i
where not i.linked_accessory
  and i.recorded_at <= now() - interval '7 days' and i.listed_on is null
  and i.channel in ('メルカリ','ヤフオク','自己発送','FBA','ヤフフリ')
  and (i.channel <> 'FBA' or not workload_private.delivery_fba_confirmed(i.id))
union all
select i.id, i.id, i.sku, i.lot_seq, i.sales_channel,
  i.marketplace, i.marketplace_item_id, i.marketplace_url, i.recorded_at, 'inspection',
  case when i.linked_accessory then coalesce(i.parent_id, i.id) else i.id end
from candidates i
where i.recorded_at <= now() - interval '3 days' and i.action_at is null
  and (i.status in ('受取前','検品中') or i.linked_accessory)
  and not (i.linked_accessory and coalesce(i.parent_action_at >= i.recorded_at, false))
  -- A date alone cannot prove completion after tracking was recorded on the same day.
  and not (i.linked_accessory and i.parent_id is not null and i.status = '商品登録前'
    and coalesce(i.work_completed_on > (i.recorded_at at time zone 'Asia/Tokyo')::date, false))
union all
select t.id, i.id, i.sku, i.lot_seq, i.sales_channel,
  i.marketplace, i.marketplace_item_id, i.marketplace_url, t.created_at, 'shipping', i.id
from app.delivery_shipping_tasks t
join app.items i on i.id = t.item_id
where (select auth.uid()) is not null and (select app.is_admin())
  and exists (select 1 from app.staff s where s.id = (select app.current_staff_id()) and s.is_active)
  and t.resolved_at is null and t.created_at <= now() - interval '24 hours'
  and i.status in ('取引中','販売済') and i.shipped_on is null
  and not app.current_trade_completed(i.id)
  and app.sales_channel_family(i.sales_channel) in ('メルカリ','ヤフオク','自己発送');

notify pgrst, 'reload schema';
