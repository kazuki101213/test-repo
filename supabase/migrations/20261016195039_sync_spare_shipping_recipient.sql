-- Keep the source holder fixed; only pending destinations follow inventory.
-- A pending allocation may temporarily need no shipment (same holder/no assignee).
alter table app.spare_shipping_tasks
  add column delivery_required boolean not null default true;
alter table app.spare_shipping_tasks drop constraint spare_shipping_tasks_check;
alter table app.spare_shipping_tasks add constraint spare_shipping_distinct_or_suspended
  check(owner_staff_id<>recipient_staff_id or (sent_at is null and not delivery_required));

create function app.sync_spare_shipping_recipient()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.deliverer_id is not distinct from old.deliverer_id then
    return new;
  end if;
  update app.spare_shipping_tasks t
  set recipient_staff_id=case
        when new.deliverer_id is not null
        then new.deliverer_id else t.recipient_staff_id end,
      delivery_required=(s.owner_staff_id is not null and new.deliverer_id is not null and new.deliverer_id<>t.owner_staff_id)
  from app.spare_accessories s
  where t.spare_id=s.id and t.item_id=new.id and t.sent_at is null and t.completed_at is null;
  return new;
end $$;
revoke all on function app.sync_spare_shipping_recipient() from public,anon,authenticated;

create trigger items_sync_spare_shipping_recipient
after update of deliverer_id on app.items
for each row execute function app.sync_spare_shipping_recipient();

-- Inline name edits previously left the holder's foreign key unchanged.
-- An explicit ID change wins; a unique registered name edit resolves that ID.
create function app.sync_spare_holder_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
declare matches uuid[]; label text;
begin
  if tg_op='UPDATE' then
    if new.owner_staff_id is distinct from old.owner_staff_id then
      select s.name into label from app.staff s where s.id=new.owner_staff_id;
      new.owner_name:=label;
      return new;
    end if;
    if new.owner_name is not distinct from old.owner_name then return new;end if;
  end if;
  select array_agg(s.id) into matches from app.staff s
  where s.is_active and regexp_replace(s.name,'[[:space:]　]','','g')=
    regexp_replace(regexp_replace(coalesce(new.owner_name,''),'[[:space:]　]','','g'),'^[A-Za-z]{2}','');
  if cardinality(matches)=1 then
    new.owner_staff_id:=matches[1];
    select s.name into new.owner_name from app.staff s where s.id=matches[1];
  end if;
  return new;
end $$;
revoke all on function app.sync_spare_holder_identity() from public,anon,authenticated;
create trigger spare_sync_holder_identity
before insert or update of owner_name,owner_staff_id on app.spare_accessories
for each row execute function app.sync_spare_holder_identity();

create function app.sync_spare_shipping_holder()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.owner_staff_id is not distinct from old.owner_staff_id then return new;end if;
  update app.spare_shipping_tasks t
  set owner_staff_id=coalesce(new.owner_staff_id,t.owner_staff_id),
      recipient_staff_id=coalesce(i.deliverer_id,t.recipient_staff_id),
      delivery_required=(new.owner_staff_id is not null and i.deliverer_id is not null and new.owner_staff_id<>i.deliverer_id)
  from app.items i
  where t.spare_id=new.id and i.id=t.item_id and t.sent_at is null and t.completed_at is null;
  return new;
end $$;
revoke all on function app.sync_spare_shipping_holder() from public,anon,authenticated;
create trigger spare_sync_shipping_holder
after update of owner_staff_id on app.spare_accessories
for each row execute function app.sync_spare_shipping_holder();

-- Only repair named, unambiguously identified holders of pending allocations.
-- Leave all dispatched/completed shipping history intact.
update app.spare_accessories s
set owner_staff_id=staff.id
from app.staff staff
where staff.is_active and s.owner_staff_id is distinct from staff.id
  and regexp_replace(staff.name,'[[:space:]　]','','g')=
      regexp_replace(regexp_replace(coalesce(s.owner_name,''),'[[:space:]　]','','g'),'^[A-Za-z]{2}','')
  and (select count(*) from app.staff other where other.is_active and
       regexp_replace(other.name,'[[:space:]　]','','g')=regexp_replace(staff.name,'[[:space:]　]','','g'))=1
  and exists(select 1 from app.spare_shipping_tasks t where t.spare_id=s.id and t.sent_at is null and t.completed_at is null);

-- Repair existing pending allocations, without changing sent/completed history.
update app.spare_shipping_tasks t
set recipient_staff_id=case
      when i.deliverer_id is not null
      then i.deliverer_id else t.recipient_staff_id end,
    delivery_required=(s.owner_staff_id is not null and i.deliverer_id is not null and i.deliverer_id<>t.owner_staff_id)
from app.items i, app.spare_accessories s
where i.id=t.item_id and s.id=t.spare_id and t.sent_at is null and t.completed_at is null
  and (t.recipient_staff_id is distinct from i.deliverer_id
       or t.delivery_required is distinct from (s.owner_staff_id is not null and i.deliverer_id is not null and i.deliverer_id<>t.owner_staff_id));

-- Preserve the existing view columns and RLS. No join to items here: a holder
-- must still see shipping requests even when they cannot read the target item.
create or replace view app.v_spare_shipping_tasks with (security_invoker=true) as
select t.id,t.spare_id,t.item_id,t.accessory_item_id,t.owner_staff_id,t.recipient_staff_id,
       t.title,t.manufacturer,t.marketplace,t.marketplace_item_id,t.usage_note,t.lot_seq,
       t.tracking_no,t.created_at,t.sent_at,t.completed_at,
       o.code owner_code,o.name owner_name,d.code recipient_code,d.name recipient_name
from app.spare_shipping_tasks t join app.staff o on o.id=t.owner_staff_id
join app.staff d on d.id=t.recipient_staff_id
where t.delivery_required or t.sent_at is not null;
