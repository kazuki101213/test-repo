-- Management follows actual tracking and shipping clocks independently of
-- photo approval and the delivery user's acknowledgement of an older notice.
create view app.v_admin_work_deadlines with (security_invoker = true, security_barrier = true) as
with candidates as (
  select i.id, i.sku, i.lot_seq, i.sales_channel, i.marketplace,
    i.marketplace_item_id, i.marketplace_url, t.recorded_at,
    i.status, i.inspected_at, i.cleaned_at, i.malfunction_reported_at,
    i.listed_on, app.sales_channel_family(i.sales_channel) as channel
  from app.items i
  join app.item_tracking_recordings t on t.item_id = i.id
  where (select auth.uid()) is not null and (select app.is_admin())
    and exists (select 1 from app.staff s where s.id = (select app.current_staff_id()) and s.is_active)
    and i.deliverer_id is not null and i.sold_on is null
    and i.status in ('受取前','検品中','商品登録前')
    and nullif(btrim(i.tracking_no), '') is not null
    and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku, i.lot_seq))
)
select i.id, i.id as item_id, i.sku, i.lot_seq, i.sales_channel, i.marketplace,
  i.marketplace_item_id, i.marketplace_url, i.recorded_at as created_at, 'listing'::text as kind
from candidates i
where i.recorded_at <= now() - interval '7 days' and i.listed_on is null
  and i.channel in ('メルカリ','ヤフオク','自己発送','FBA','ヤフフリ')
  and (i.channel <> 'FBA' or not workload_private.delivery_fba_confirmed(i.id))
union all
select i.id, i.id, i.sku, i.lot_seq, i.sales_channel, i.marketplace,
  i.marketplace_item_id, i.marketplace_url, i.recorded_at, 'inspection'
from candidates i
where i.recorded_at <= now() - interval '3 days'
  and i.status in ('受取前','検品中') and i.inspected_at is null
  and i.cleaned_at is null and i.malfunction_reported_at is null
union all
select t.id, i.id, i.sku, i.lot_seq, i.sales_channel, i.marketplace,
  i.marketplace_item_id, i.marketplace_url, t.created_at, 'shipping'
from app.delivery_shipping_tasks t
join app.items i on i.id = t.item_id
where (select auth.uid()) is not null and (select app.is_admin())
  and exists (select 1 from app.staff s where s.id = (select app.current_staff_id()) and s.is_active)
  and t.resolved_at is null and t.created_at <= now() - interval '24 hours'
  and i.status in ('取引中','販売済') and i.shipped_on is null
  and not app.current_trade_completed(i.id)
  and app.sales_channel_family(i.sales_channel) in ('メルカリ','ヤフオク','自己発送');
revoke all on app.v_admin_work_deadlines from public, anon;
grant select on app.v_admin_work_deadlines to authenticated;

do $migration$
declare original text; patched text; shipping_start integer; receipt_start integer; old_branches text;
begin
  original := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  shipping_start := strpos(original, $tag$when 'admin_shipping_tasks' then$tag$);
  receipt_start := strpos(original, $tag$when 'receipt_tasks' then$tag$);
  if shipping_start = 0 or receipt_start <= shipping_start then
    raise exception 'Management task snapshot branches not found';
  end if;
  old_branches := substring(original from shipping_start for receipt_start - shipping_start);
  if strpos(old_branches, 'photo_reviews') = 0 or strpos(old_branches, 'approved_at') = 0 then
    raise exception 'Management listing criteria changed unexpectedly';
  end if;
  patched := replace(original, old_branches, $new$when 'admin_shipping_tasks' then
  if not app.is_admin() then raise exception '管理者のみ閲覧できます' using errcode='42501';end if;
  source:=$q$select to_jsonb(t) d from app.v_admin_work_deadlines t where t.kind='shipping'$q$;
 when 'admin_inspection_tasks' then
  if not app.is_admin() then raise exception '管理者のみ閲覧できます' using errcode='42501';end if;
  source:=$q$select to_jsonb(t) d from app.v_admin_work_deadlines t where t.kind='inspection'$q$;
 when 'listing_tasks' then
  source:=$q$select to_jsonb(t) d from app.v_admin_work_deadlines t where t.kind='listing'$q$;
 $new$);
  execute patched;
end $migration$;
notify pgrst, 'reload schema';
