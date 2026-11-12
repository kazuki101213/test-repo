-- The body SKU uses the same original-body-plus-accessories cost as accounting.
-- Each accessory retains its own purchase cost. Do not rewrite marketplace SKUs.
create function app.sku_with_total_cost(p_item app.items) returns text
language plpgsql stable security definer set search_path='' as $$
declare family text; body_cost bigint; accessory_cost bigint;normalized text;persisted_sku text;
begin
 if p_item.sku !~ '^[0-9]+[a-z]*-[A-Z]{2,4}-[0-9]{8}-[0-9]+$' then return p_item.sku;end if;
 if p_item.is_accessory then
  normalized:=regexp_replace(p_item.sku,'-[0-9]+$','-'||(p_item.cost_amount/10)::text);
 else
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
  normalized:=regexp_replace(p_item.sku,'-[0-9]+$','-'||((body_cost+accessory_cost)/10)::text);
 end if;
 -- Legacy bodies and accessories sometimes share the entire SKU prefix.
 -- A reserved historical/live SKU must never switch to another item ID.
 select i.sku into persisted_sku from app.items i where i.id=p_item.id;
 if persisted_sku is not null and regexp_replace(persisted_sku,'-[0-9]+$','')=regexp_replace(normalized,'-[0-9]+$','')
  and (exists(select 1 from app.items i where i.sku=normalized and i.id<>p_item.id)
   or exists(select 1 from app.item_sku_aliases a where a.sku=normalized and a.item_id<>p_item.id)
   or exists(select 1 from app.seller_operations o where o.item_id=p_item.id
     and o.status in ('queued','running','uncertain'))) then
  return persisted_sku;
 end if;
 return normalized;
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
  -- Generated columns are computed after BEFORE triggers. Exclude their
  -- transient NEW null, while still checking every input business field.
  patched:=replace(patched,$oldguard$to_jsonb(new)-'sku'-'updated_at'=to_jsonb(old)-'sku'-'updated_at'$oldguard$,
   $newguard$to_jsonb(new)-'sku'-'updated_at'-'profit'=to_jsonb(old)-'sku'-'updated_at'-'profit'$newguard$);
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
declare parent app.items;projected_cost bigint;old_accessory_cost bigint:=0;candidate text;attempt integer:=0;
begin
 new.sku:=app.sku_with_total_cost(new);
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
  select i.* into parent from app.items i where i.id=new.parent_item_id and not i.is_accessory;
  if parent.id is not null then
   if tg_op='UPDATE' and old.is_accessory and not app.is_standalone_accessory_serial(old.sku,old.lot_seq)
    and app.financial_product_serial(old.sku,old.lot_seq)=app.financial_product_serial(parent.sku,parent.lot_seq) then
    old_accessory_cost:=old.cost_amount;
   end if;
   select f.family_cost+new.cost_amount-old_accessory_cost into projected_cost from app.v_financial_families f
    where f.family_key=app.financial_product_serial(parent.sku,parent.lot_seq);
   candidate:=regexp_replace(parent.sku,'-[0-9]+$','-'||(projected_cost/10)::text);
   -- Reserve the body's future total-cost SKU before inserting a zero-cost
   -- body's same-prefix accessory. New accessories have no old SKU to lose.
   if new.sku=candidate and (tg_op='INSERT' or new.parent_item_id is distinct from old.parent_item_id) then
    loop
     new.sku:=regexp_replace(new.sku,'^([0-9]+[a-z]*)(-)','\1a\2');
     attempt:=attempt+1;
     exit when not exists(select 1 from app.items i where i.sku=new.sku and i.id<>new.id)
      and not exists(select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id);
     if attempt>30 then raise exception '付属品SKUを確保できません' using errcode='23505';end if;
    end loop;
   end if;
  end if;
 end if;
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

-- FBA plans and stock reports retain the SKU captured from Amazon.
create function app.inventory_sku_matches(item_id uuid, current_sku text, reference_sku text)
returns boolean language sql stable security invoker set search_path='' as $$
  select current_sku=reference_sku or exists(
    select 1 from app.item_sku_aliases a
    where a.item_id=inventory_sku_matches.item_id and a.sku=reference_sku
  );
$$;
revoke all on function app.inventory_sku_matches(uuid,text,text) from public,anon;
grant execute on function app.inventory_sku_matches(uuid,text,text) to authenticated,service_role;

do $fba$
declare
  source text;
  patched text;
  target regprocedure;
  anchor text;
begin
 for target,anchor in select * from (values
  ('app.publish_fba_inbound_items(uuid,uuid[])'::regprocedure, 'i.sku=f.sku'),
  ('app.record_fba_completion_dispatch_date()'::regprocedure, 'i.sku = f.sku'),
  ('workload_private.delivery_fba_confirmed(uuid)'::regprocedure, 'f.sku = i.sku')
 ) as guards(fn, expression) loop
  source:=pg_get_functiondef(target);
  patched:=replace(source,anchor,'app.inventory_sku_matches(i.id,i.sku,f.sku)');
  if source=patched then raise exception 'FBA SKU guard changed: %',target;end if;
  execute patched;
 end loop;

 source:=pg_get_viewdef('workload_private.fba_stock_evidence'::regclass,true);
 patched:=replace(source,'item.item_id, item.sku, plan.account','item.item_id, inventory.sku AS sku, plan.account');
 patched:=replace(patched,'GROUP BY item.item_id, inventory.sku AS sku, plan.account','GROUP BY item.item_id, inventory.sku, plan.account');
 patched:=replace(patched,'FROM app.fba_inbound_items item','FROM app.fba_inbound_items item
  JOIN app.items inventory ON inventory.id=item.item_id
   AND app.inventory_sku_matches(inventory.id,inventory.sku,item.sku)');
 if source=patched or position('inventory.sku AS sku' in patched)=0 or position('JOIN app.items inventory' in patched)=0 then
  raise exception 'FBA stock evidence SKU anchor changed';
 end if;
 execute 'create or replace view workload_private.fba_stock_evidence with (security_barrier=true) as '||patched;

 source:=pg_get_functiondef('app.create_fba_inbound_draft(uuid,uuid[])'::regprocedure);
 patched:=replace(source,'values(v_plan,v_item.id,v_item.sku,btrim(v_item.asin::text)',
 $sku$values(v_plan,v_item.id,coalesce(
   (select s.sku from app.amazon_listing_submissions s
    where s.item_id=v_item.id and s.asin=btrim(v_item.asin::text) and s.item_condition=v_item.condition::text
     and s.account_id=case when v_account='FBA2' then 'amazon-2' else 'amazon-1' end
     and s.sales_channel::text in (v_account,case when v_account='FBA1' then 'FBA' else v_account end)
     and (s.state='verified' or (s.state='accepted' and s.submission_id is not null))
     and app.inventory_sku_matches(v_item.id,v_item.sku,s.sku)
    order by s.created_at desc,s.request_id limit 1),
   (select prior.sku from app.fba_inbound_items prior join app.fba_inbound_plans previous on previous.id=prior.plan_id
    where prior.item_id=v_item.id and previous.account=v_account and previous.amazon_id is not null
     and prior.asin=btrim(v_item.asin::text) and prior.condition=v_item.condition::text
     and app.inventory_sku_matches(v_item.id,v_item.sku,prior.sku)
    order by previous.created_at desc,previous.id limit 1),
   v_item.sku),btrim(v_item.asin::text)$sku$);
 if source=patched then raise exception 'FBA draft SKU snapshot anchor changed';end if;
 execute patched;
end $fba$;

-- Existing records follow the same rule. The normal alias/audit triggers keep
-- all old SKUs resolvable; no prices, costs, state, or external listings change.
do $backfill$
declare before_hash text;after_hash text;
begin
 select md5(string_agg((to_jsonb(i)-'sku'-'updated_at')::text,'|' order by i.id)) into before_hash from app.items i;
 with proposed as materialized (
  select i.id, i.sku, app.sku_with_total_cost(i) as target from app.items i
 ), unambiguous as (
  select id,target,count(*) over(partition by target) as target_count from proposed where sku is distinct from target
 )
 update app.items i set sku=p.target from unambiguous p where i.id=p.id and p.target_count=1;
 select md5(string_agg((to_jsonb(i)-'sku'-'updated_at')::text,'|' order by i.id)) into after_hash from app.items i;
 if before_hash is distinct from after_hash then
  raise exception 'SKU補正で他の在庫情報が変更されたため処理を取り消しました';end if;
end $backfill$;
notify pgrst,'reload schema';
