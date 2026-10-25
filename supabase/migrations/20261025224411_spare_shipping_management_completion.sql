-- Management acknowledgement is independent of the holder's physical shipment.
alter table app.spare_shipping_tasks add column management_completed_at timestamptz;
grant update(management_completed_at) on app.spare_shipping_tasks to authenticated;
create policy spare_shipping_management_complete on app.spare_shipping_tasks
for update to authenticated using(app.is_admin()) with check(app.is_admin());

create or replace function app.complete_spare_shipping(p_task_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者のみ完了できます' using errcode='42501';
  end if;
  update app.spare_shipping_tasks
  set management_completed_at=coalesce(management_completed_at,now()),
      completed_at=case when sent_at is not null then coalesce(completed_at,now()) else completed_at end
  where id=p_task_id;
  if not found then raise exception '発送タスクが見つかりません' using errcode='22023'; end if;
end $$;
revoke all on function app.complete_spare_shipping(uuid) from public,anon;
grant execute on function app.complete_spare_shipping(uuid) to authenticated;

create or replace view app.v_spare_shipping_tasks with (security_invoker=true) as
select t.id,t.spare_id,t.item_id,t.accessory_item_id,t.owner_staff_id,t.recipient_staff_id,
       t.title,t.manufacturer,t.marketplace,t.marketplace_item_id,t.usage_note,t.lot_seq,
       t.tracking_no,t.created_at,t.sent_at,t.completed_at,
       o.code owner_code,o.name owner_name,d.code recipient_code,d.name recipient_name,
       t.management_completed_at
from app.spare_shipping_tasks t join app.staff o on o.id=t.owner_staff_id
join app.staff d on d.id=t.recipient_staff_id
where t.delivery_required or t.sent_at is not null;
