-- Remember when tracking first became available. Corrections to an existing
-- number preserve the deadline, and unrelated inventory updates do not reset it.
create table app.item_tracking_recordings (
  item_id uuid primary key references app.items(id) on delete cascade,
  recorded_at timestamptz not null
);
alter table app.item_tracking_recordings enable row level security;
revoke all on app.item_tracking_recordings from public, anon, authenticated;
grant select on app.item_tracking_recordings to authenticated;
create policy item_tracking_recordings_read on app.item_tracking_recordings for select to authenticated
using (
  exists (select 1 from app.staff s where s.id = (select app.current_staff_id()) and s.is_active)
  and exists (select 1 from app.items i where i.id = item_tracking_recordings.item_id
    and ((select app.is_admin()) or i.deliverer_id = (select app.current_staff_id())))
);

create function app.capture_item_tracking_recording()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if nullif(btrim(new.tracking_no), '') is null then
    if tg_op = 'UPDATE' and nullif(btrim(old.tracking_no), '') is not null then
      delete from app.item_tracking_recordings where item_id = new.id;
    end if;
  elsif tg_op = 'INSERT' or nullif(btrim(old.tracking_no), '') is null then
    insert into app.item_tracking_recordings(item_id, recorded_at)
    values (new.id, clock_timestamp()) on conflict (item_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function app.capture_item_tracking_recording() from public, anon, authenticated;
create trigger items_tracking_recording after insert or update of tracking_no on app.items
  for each row execute function app.capture_item_tracking_recording();

-- Use the actual recorded transition for existing products, including records
-- that were originally inserted with a number. Do not invent missing dates.
insert into app.item_tracking_recordings(item_id, recorded_at)
select i.id, history.created_at
from app.items i
cross join lateral (
  select a.created_at from app.audit_log a
  where a.table_name = 'items' and a.row_id = i.id
    and nullif(btrim(a.new_data->>'tracking_no'), '') is not null
    and nullif(btrim(a.old_data->>'tracking_no'), '') is null
  order by a.created_at desc limit 1
) history
where nullif(btrim(i.tracking_no), '') is not null
on conflict (item_id) do nothing;

-- FBA plan tables are private. An active user may only learn whether an item
-- they can handle has completed the inbound confirmation for its current SKU.
create function workload_private.delivery_fba_confirmed(p_item_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.items i
    join app.staff actor on actor.id = (select app.current_staff_id()) and actor.is_active
    join app.fba_inbound_items f on f.item_id = i.id and f.sku = i.sku
    join app.fba_inbound_plans p on p.id = f.plan_id and p.staff_id = i.deliverer_id
    where (select auth.uid()) is not null and i.id = p_item_id
      and (actor.role = 'admin' or actor.id = i.deliverer_id)
      and p.stage = 'ready' and (f.released_at is null or f.published_at is not null)
      and p.account = case when i.sales_channel::text = 'FBA' then 'FBA1' else i.sales_channel::text end
  )
$$;
revoke all on function workload_private.delivery_fba_confirmed(uuid) from public, anon, authenticated;
grant execute on function workload_private.delivery_fba_confirmed(uuid) to authenticated;

create view app.v_delivery_work_tasks with (security_invoker = true, security_barrier = true) as
with notices as materialized (
  select n.*, t.recorded_at as tracking_recorded_at
  from app.v_delivery_notice_tasks n
  left join app.item_tracking_recordings t on t.item_id = n.item_id
  where n.kind <> 'photo_approved' or not workload_private.delivery_fba_confirmed(n.item_id)
), candidates as (
  select i.id, i.sku, i.lot_seq, i.marketplace_item_id, i.marketplace, i.marketplace_url,
    i.created_at, t.recorded_at, i.status, i.inspected_at, i.cleaned_at, i.malfunction_reported_at,
    i.listed_on, app.sales_channel_family(i.sales_channel) as channel
  from app.items i
  left join app.item_tracking_recordings t on t.item_id = i.id
  where (select auth.uid()) is not null
    and exists (select 1 from app.staff s where s.id = (select app.current_staff_id()) and s.is_active)
    and ((select app.is_admin()) or i.deliverer_id = (select app.current_staff_id()))
    and i.deliverer_id is not null
    and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku, i.lot_seq))
    and i.status in ('受取前','検品中','商品登録前') and i.sold_on is null
    and nullif(btrim(i.tracking_no), '') is not null
)
select * from notices
union all
select 'inspection:'||i.id::text, i.id, 'inspection', coalesce(i.recorded_at, i.created_at),
  i.sku, i.lot_seq, i.marketplace_item_id, i.marketplace, i.marketplace_url,
  null::timestamptz, null::text, i.recorded_at
from candidates i
where i.status in ('受取前','検品中') and i.inspected_at is null
  and i.cleaned_at is null and i.malfunction_reported_at is null
union all
select 'listing_due:'||i.id::text, i.id, 'listing_due', i.recorded_at,
  i.sku, i.lot_seq, i.marketplace_item_id, i.marketplace, i.marketplace_url,
  null::timestamptz, null::text, i.recorded_at
from candidates i
where i.recorded_at is not null and i.listed_on is null
  and i.channel in ('FBA','自己発送','メルカリ','ヤフオク','ヤフフリ')
  and not exists (select 1 from notices n where n.item_id = i.id and n.kind = 'photo_approved')
  and (i.channel <> 'FBA' or not workload_private.delivery_fba_confirmed(i.id));
revoke all on app.v_delivery_work_tasks from public, anon;
grant select on app.v_delivery_work_tasks to authenticated;

do $migration$
declare original text; patched text;
begin
  original := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  patched := replace(original, $old$when 'return_tasks' then$old$, $new$when 'delivery_work_tasks' then
  source:=$q$select to_jsonb(t) d from app.v_delivery_work_tasks t$q$;
 when 'return_tasks' then$new$);
  if patched = original then raise exception 'Delivery notice snapshot branch not found'; end if;
  execute patched;
end $migration$;
notify pgrst, 'reload schema';
