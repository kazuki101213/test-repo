-- A linked accessory without an assignee must follow its body, otherwise
-- delivery RLS correctly hides it from the body's assigned staff.
-- Preserve explicit accessory assignments and all existing RLS policies.
create function app.inherit_unassigned_accessory_deliverer()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_accessory and new.parent_item_id is not null and new.deliverer_id is null then
    select p.deliverer_id into new.deliverer_id from app.items p
      where p.id=new.parent_item_id and not p.is_accessory;
  end if;
  return new;
end $$;
revoke all on function app.inherit_unassigned_accessory_deliverer() from public,anon,authenticated;

-- Run after the existing before-insert parent-linking trigger (alphabetical order).
create trigger items_zz_inherit_unassigned_accessory_deliverer
before insert or update of parent_item_id,deliverer_id,is_accessory on app.items
for each row execute function app.inherit_unassigned_accessory_deliverer();

create function app.assign_unassigned_child_accessories()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not new.is_accessory and new.deliverer_id is not null
     and new.deliverer_id is distinct from old.deliverer_id then
    update app.items a set deliverer_id=new.deliverer_id
      where a.is_accessory and a.parent_item_id=new.id and a.deliverer_id is null;
  end if;
  return new;
end $$;
revoke all on function app.assign_unassigned_child_accessories() from public,anon,authenticated;
create trigger items_assign_unassigned_child_accessories
after update of deliverer_id on app.items
for each row execute function app.assign_unassigned_child_accessories();

-- Repair only confirmed links with a missing assignment. Existing audit records
-- capture before/after data; SKU, purchase details and explicit holders stay intact.
update app.items a set deliverer_id=p.deliverer_id
from app.items p where a.is_accessory and a.parent_item_id=p.id
  and a.deliverer_id is null and not p.is_accessory and p.deliverer_id is not null;
