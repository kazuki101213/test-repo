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
after update on app.spare_accessories
for each row execute function app.sync_spare_shipping_holder();

-- Repair uniquely named holders, including legacy allocations without a task.
-- The shipping trigger still leaves dispatched/completed history intact.
update app.spare_accessories s
set owner_staff_id=staff.id
from app.staff staff
where staff.is_active and s.owner_staff_id is distinct from staff.id
  and regexp_replace(staff.name,'[[:space:]　]','','g')=
      regexp_replace(regexp_replace(coalesce(s.owner_name,''),'[[:space:]　]','','g'),'^[A-Za-z]{2}','')
  and (select count(*) from app.staff other where other.is_active and
       regexp_replace(other.name,'[[:space:]　]','','g')=regexp_replace(staff.name,'[[:space:]　]','','g'))=1
  ;

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

-- Avoid updating the accessory twice while its BEFORE trigger redirects to the body.
create or replace function app.redirect_accessory_shared_edits()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype; previous_redirect text;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory
     or app.is_standalone_accessory_serial(old.sku,old.lot_seq) then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  select p.* into parent from app.items p
  where not p.is_accessory and (
    p.id = coalesce(new.parent_item_id, old.parent_item_id)
    or (new.parent_item_id is null and old.parent_item_id is null
        and p.lot_seq = old.lot_seq
        and app.product_serial(p.sku,p.lot_seq) = app.product_serial(old.sku,old.lot_seq))
  )
  order by (p.id = coalesce(new.parent_item_id, old.parent_item_id)) desc
  limit 1
  for update;

  if parent.id is null then
    raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください' using errcode='22023';
  end if;

  previous_redirect:=current_setting('app.redirecting_accessory_id',true);
  perform set_config('app.redirecting_accessory_id',old.id::text,true);
  update app.items set
    status = new.status,
    packed_on = new.packed_on,
    shipped_on = new.shipped_on,
    returned_on = new.returned_on,
    sales_channel = new.sales_channel,
    condition = new.condition,
    sold_on = new.sold_on,
    sold_price = new.sold_price,
    payout_amount = new.payout_amount,
    lot_seq = new.lot_seq,
    deliverer_id = new.deliverer_id,
    sku = parent.sku
  where id = parent.id;

  perform set_config('app.redirecting_accessory_id',coalesce(previous_redirect,''),true);
  select * into parent from app.items where id = parent.id;
  new.parent_item_id := parent.id;
  new.status := parent.status;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.returned_on := parent.returned_on;
  new.sales_channel := parent.sales_channel;
  new.condition := parent.condition;
  new.sold_on := parent.sold_on;
  new.sold_price := parent.sold_price;
  new.payout_amount := parent.payout_amount;
  new.lot_seq := parent.lot_seq;
  new.deliverer_id := parent.deliverer_id;
  new.sku := app.accessory_sku_for_parent(parent.sku, old.sku);
  return new;
end;
$$;


create or replace function app.sync_accessory_sale_date()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  accessory app.items%rowtype;
begin
  if new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  for accessory in
    select a.* from app.items a
    where a.id::text is distinct from nullif(current_setting('app.redirecting_accessory_id',true),'')
      and a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and (
      a.parent_item_id = new.id
      or (a.parent_item_id is null and a.lot_seq = old.lot_seq
          and app.product_serial(a.sku,a.lot_seq) = app.product_serial(old.sku,old.lot_seq))
    )
    for update
  loop
    update app.items set
      parent_item_id = new.id,
      status = new.status,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      returned_on = new.returned_on,
      sales_channel = new.sales_channel,
      condition = new.condition,
      sold_on = new.sold_on,
      sold_price = new.sold_price,
      payout_amount = new.payout_amount,
      sku = app.accessory_sku_for_parent(new.sku, accessory.sku),
      lot_seq = new.lot_seq,
      deliverer_id = new.deliverer_id
    where id = accessory.id;
  end loop;
  return new;
end;
$$;
