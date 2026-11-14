-- Preserve the original purchase separately from the spare's physical holder.
alter table app.spare_accessories add column purchaser_id uuid references app.staff(id);

-- Prefer the earliest identifiable purchase, before a spare could have been
-- allocated under its holder's code. The marketplace reference also covers
-- old zero-cost bundled remotes and Amazon order IDs with legacy source labels.
create temporary table spare_original_purchaser on commit drop as
with history as materialized (
  select created_at, coalesce(new_data, old_data) as item
  from app.audit_log where table_name = 'items' and action in ('INSERT', 'DELETE')
), candidates as (
  select s.id as spare_id, b.id as purchaser_id,
    dense_rank() over (partition by s.id order by
      case when h.item->>'marketplace_item_id' = s.marketplace_item_id then 1 else 2 end,
      h.created_at) as priority
  from app.spare_accessories s
  join history h on h.created_at <= s.created_at and (
    h.item->>'sku' = s.source_sku or (
      nullif(s.marketplace_item_id, '') = h.item->>'marketplace_item_id'
      and (s.marketplace = h.item->>'marketplace' or s.marketplace_item_id ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$')
      and (s.purchased_at::text = h.item->>'purchased_at'
        or (s.cost_amount = 0 and lower(s.usage_note) = lower(substring(h.item->>'sku' from '^[0-9]+[A-Za-z]*'))))
      and (s.cost_amount = 0 or s.cost_amount::text = h.item->>'cost_amount')
    )
  )
  join app.staff b on b.id::text = h.item->>'purchaser_id' and b.code in ('AA', 'EE')
)
select spare_id, (array_agg(purchaser_id))[1] as purchaser_id
from candidates where priority = 1 group by spare_id having count(distinct purchaser_id) = 1;

create temporary table spare_accessory_match on commit drop as
with candidates as (
  select i.id as item_id, s.id as spare_id,
    dense_rank() over (partition by i.id order by case when
      t.accessory_item_id is not null or i.id in (s.linked_item_id, s.used_for_item_id) then 1 else 2 end) as priority
  from app.items i
  join app.spare_accessories s on
    i.id in (s.linked_item_id, s.used_for_item_id) or (
      s.used_for_item_id = i.parent_item_id and nullif(s.marketplace_item_id, '') = i.marketplace_item_id
      and s.marketplace = i.marketplace::text and s.purchased_at is not distinct from i.purchased_at
      and s.cost_amount = i.cost_amount
    ) or exists (select 1 from app.spare_shipping_tasks t where t.spare_id = s.id and t.accessory_item_id = i.id)
  left join app.spare_shipping_tasks t on t.spare_id = s.id and t.accessory_item_id = i.id
  where i.is_accessory
)
select item_id, (array_agg(spare_id))[1] as spare_id
from candidates where priority = 1 group by item_id having count(distinct spare_id) = 1;

update app.spare_accessories s
set purchaser_id = coalesce(
  (select b.purchaser_id from spare_original_purchaser b where b.spare_id = s.id),
  (select (array_agg(distinct i.purchaser_id))[1]
    from spare_accessory_match m join app.items i on i.id = m.item_id
    join app.staff buyer on buyer.id = i.purchaser_id and buyer.code in ('AA', 'EE')
    where m.spare_id = s.id having count(distinct i.purchaser_id) = 1),
  (select id from app.staff where code = 'AA')
);

-- Correct recovered owners for spares and apply the requested legacy fallback
-- to any remaining inventory rows. The SKU trigger keeps previous SKUs as aliases.
with corrections as materialized (
  select i.id, coalesce(original.purchaser_id,
    case when coalesce(buyer.code, '') not in ('AA', 'EE') then (select id from app.staff where code = 'AA')
         else i.purchaser_id end) as purchaser_id
  from app.items i left join app.staff buyer on buyer.id = i.purchaser_id
  left join spare_accessory_match m on m.item_id = i.id
  left join spare_original_purchaser original on original.spare_id = m.spare_id
)
update app.items i set purchaser_id = c.purchaser_id
from corrections c where i.id = c.id and i.purchaser_id is distinct from c.purchaser_id;

alter table app.spare_accessories alter column purchaser_id set not null;

create function app.default_spare_purchaser() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.purchaser_id := coalesce(new.purchaser_id, app.current_staff_id(),
    (select id from app.staff where code = 'AA'));
  return new;
end $$;
revoke all on function app.default_spare_purchaser() from public, anon, authenticated;
create trigger spare_default_purchaser before insert on app.spare_accessories
for each row execute function app.default_spare_purchaser();

do $functions$
declare source text; patched text;
begin
  source := pg_get_functiondef('app.register_item_with_spare(jsonb,uuid)'::regprocedure);
  patched := replace(source, 'coalesce(v_spare.owner_staff_id,v_item.purchaser_id)', 'v_spare.purchaser_id');
  if patched = source then raise exception 'Spare allocation purchaser expression changed'; end if;
  source := patched;
  patched := replace(source, 'v_input.parent_item_id := v_parent_id;', $allocation$
    v_input.parent_item_id := v_parent_id;
    if v_input.sku is not null and v_input.purchaser_id is distinct from v_spare.purchaser_id then
      v_input.sku := regexp_replace(v_input.sku, '^([0-9]+[a-z]*-)[a-z]{2,4}(-)',
        '\1' || (select code from app.staff where id = v_spare.purchaser_id)
             || coalesce((select code from app.staff where id = v_input.deliverer_id), '') || '\2', 'i');
    end if;
    v_input.purchaser_id := v_spare.purchaser_id;
  $allocation$);
  if patched = source then raise exception 'Spare accessory allocation expression changed'; end if;
  execute patched;

  source := pg_get_functiondef('app.queue_spare_shipping(uuid,uuid,uuid)'::regprocedure);
  patched := replace(source,
    '(not i.is_accessory and a.purchaser_id is distinct from coalesce(s.owner_staff_id,i.purchaser_id))',
    '(a.purchaser_id is distinct from s.purchaser_id)');
  if patched = source then raise exception 'Spare shipping purchaser validation changed'; end if;
  source := patched;
  patched := replace(source, 'or i.purchaser_id is distinct from app.current_staff_id()))',
    'or (not i.is_accessory and i.purchaser_id is distinct from app.current_staff_id())))');
  if patched = source then raise exception 'Spare shipping access validation changed'; end if;
  execute patched;

  source := pg_get_functiondef('app.move_inventory_accessory_to_spares(uuid,jsonb)'::regprocedure);
  patched := replace(source, 'source_sku,owner_staff_id,owner_name,purchased_at,',
    'source_sku,owner_staff_id,owner_name,purchaser_id,purchased_at,');
  if patched = source then raise exception 'Spare transfer columns changed'; end if;
  source := patched;
  patched := replace(source, 'v_owner_id,v_owner_name,', 'v_owner_id,v_owner_name,v_item.purchaser_id,');
  if patched = source then raise exception 'Spare transfer values changed'; end if;
  execute patched;

  source := pg_get_functiondef('app.prepare_yahoo_auction_item(uuid)'::regprocedure);
  patched := replace(source, 'source_sku,owner_staff_id,owner_name,purchased_at,',
    'source_sku,owner_staff_id,owner_name,purchaser_id,purchased_at,');
  if patched = source then raise exception 'Bundled spare columns changed'; end if;
  source := patched;
  patched := replace(source, 'null,v_owner_id,v_owner_name,v_body.purchased_at,',
    'null,v_owner_id,v_owner_name,v_body.purchaser_id,v_body.purchased_at,');
  if patched = source then raise exception 'Bundled spare values changed'; end if;
  execute patched;

  source := pg_get_functiondef('app.register_purchase_draft_spare(uuid,jsonb)'::regprocedure);
  patched := replace(source, 'owner_staff_id,owner_name,purchased_at,',
    'owner_staff_id,owner_name,purchaser_id,purchased_at,');
  if patched = source then raise exception 'Draft spare columns changed'; end if;
  source := patched;
  patched := replace(source, 'owner_id,owner_label,purchase_date,',
    'owner_id,owner_label,nullif(p_input->>''purchaser_id'','''')::uuid,purchase_date,');
  if patched = source then raise exception 'Draft spare values changed'; end if;
  execute patched;
end $functions$;

notify pgrst, 'reload schema';
