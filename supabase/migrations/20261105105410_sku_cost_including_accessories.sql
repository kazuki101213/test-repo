-- The body SKU uses the same original-body-plus-accessories cost as accounting.
-- Each accessory retains its own purchase cost. Do not rewrite marketplace SKUs.
create function app.sku_with_total_cost(p_item app.items) returns text
language plpgsql stable security definer set search_path='' as $$
declare family text; body_cost bigint; accessory_cost bigint;
begin
 if p_item.sku !~ '^[0-9]+[a-z]*-[A-Z]{2,4}-[0-9]{8}-[0-9]+$' then return p_item.sku;end if;
 if p_item.is_accessory then
  return regexp_replace(p_item.sku,'-[0-9]+$','-'||(p_item.cost_amount/10)::text);
 end if;
 family:=app.financial_product_serial(p_item.sku,p_item.lot_seq);
 -- Include NEW and exclude its persisted version, so inserts and cost edits
 -- use the exact same origin ordering as v_financial_families.
 select c.cost_amount into body_cost from (
  select i.id,i.sku,i.lot_seq,i.cost_amount,i.purchased_at,i.created_at
  from app.items i where i.id<>p_item.id
   and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
   and app.financial_product_serial(i.sku,i.lot_seq)=family
  union all
  select p_item.id,p_item.sku,p_item.lot_seq,p_item.cost_amount,p_item.purchased_at,p_item.created_at
 ) c order by (lower(app.product_serial(c.sku,c.lot_seq))=family) desc,
  c.purchased_at nulls last,c.created_at,c.id limit 1;
 select coalesce(sum(a.cost_amount),0)::bigint into accessory_cost from app.items a
 where a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
  and app.financial_product_serial(a.sku,a.lot_seq)=family;
 return regexp_replace(p_item.sku,'-[0-9]+$','-'||((body_cost+accessory_cost)/10)::text);
end $$;
revoke all on function app.sku_with_total_cost(app.items) from public,anon,authenticated;

-- Keep existing identity, date, alias, and shared-field guards. Only replace
-- their cost calculation and their verified tail-only correction exception.
do $migration$
declare name text;source text;patched text;
begin
 foreach name in array array['sync_sku_from_item_identity','normalize_return_sku_insert'] loop
  source:=pg_get_functiondef(('app.'||name||'()')::regprocedure);
  patched:=replace(source,'new.sku:=app.return_sku_original_cost(new.sku,new.lot_seq);',
   'new.sku:=app.sku_with_total_cost(new);');
  if source=patched then raise exception 'SKU normalization anchor changed: %',name;end if;
  execute patched;
 end loop;
 foreach name in array array['redirect_accessory_shared_edits','sync_accessory_sale_date'] loop
  source:=pg_get_functiondef(('app.'||name||'()')::regprocedure);
  patched:=replace(source,'new.sku=app.return_sku_original_cost(old.sku,old.lot_seq)',
   'new.sku=app.sku_with_total_cost(new)');
  if source=patched then raise exception 'SKU correction guard anchor changed: %',name;end if;
  execute patched;
 end loop;
 -- Usage reassignment is accessory-specific: preserve its own cost during
 -- collision checks instead of applying the original body's return cost.
 source:=pg_get_functiondef('app.reassign_accessory_usage(uuid,text,timestamptz)'::regprocedure);
 patched:=replace(source,'app.return_sku_original_cost(serial||suffix||tail,target.lot_seq)','serial||suffix||tail');
 patched:=replace(patched,'app.return_sku_original_cost(app.accessory_sku_for_parent(target.sku,candidate),target.lot_seq)',
  'app.accessory_sku_for_parent(target.sku,candidate)');
 patched:=replace(patched,'app.return_sku_original_cost(app.accessory_sku_for_parent(target.sku,a.sku),target.lot_seq)',
  'app.accessory_sku_for_parent(target.sku,a.sku)');
 if source=patched or position('app.return_sku_original_cost(' in patched)>0 then
  raise exception 'Accessory usage cost anchors changed';end if;
 execute patched;
end $migration$;

create function app.normalize_item_sku_total_cost() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 new.sku:=app.sku_with_total_cost(new);
 if exists(select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then
  raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';end if;
 return new;
end $$;
revoke all on function app.normalize_item_sku_total_cost() from public,anon,authenticated;
-- Run after all existing identity/return normalization on inserts and updates.
create trigger zzz_items_normalize_sku_total_cost
 before insert or update of sku,cost_amount,lot_seq,purchased_at,purchaser_id,deliverer_id,is_accessory,parent_item_id
 on app.items for each row execute function app.normalize_item_sku_total_cost();

create function app.refresh_family_sku_costs() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_family text;new_family text;candidate app.items;normalized text;
begin
 if tg_op<>'INSERT' then old_family:=app.financial_product_serial(old.sku,old.lot_seq);end if;
 if tg_op<>'DELETE' then new_family:=app.financial_product_serial(new.sku,new.lot_seq);end if;
 if tg_op='UPDATE' and old_family is not distinct from new_family
  and new.cost_amount is not distinct from old.cost_amount
  and new.is_accessory is not distinct from old.is_accessory
  and new.parent_item_id is not distinct from old.parent_item_id
  and new.purchased_at is not distinct from old.purchased_at then return null;end if;
 -- Only bodies need propagation. Accessories are normalized in BEFORE, so
 -- concurrent accessory updates never need to acquire each other's row locks.
 for candidate in select i.* from app.items i where not i.is_accessory
  and app.financial_product_serial(i.sku,i.lot_seq) in(old_family,new_family)
  order by i.id for update loop
  normalized:=app.sku_with_total_cost(candidate);
  if normalized is distinct from candidate.sku then
   update app.items set sku=normalized where id=candidate.id;
  end if;
 end loop;
 return null;
end $$;
revoke all on function app.refresh_family_sku_costs() from public,anon,authenticated;
create trigger zz_items_refresh_family_sku_costs after insert or update or delete
 on app.items for each row execute function app.refresh_family_sku_costs();

-- Existing records follow the same rule. The normal alias/audit triggers keep
-- all old SKUs resolvable; no prices, costs, state, or external listings change.
update app.items i set sku=app.sku_with_total_cost(i)
where i.sku is distinct from app.sku_with_total_cost(i);
notify pgrst,'reload schema';
