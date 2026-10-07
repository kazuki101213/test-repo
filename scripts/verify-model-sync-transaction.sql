-- Run after the model-sync migration. All fixture changes are rolled back.
begin;
do $$ begin
  perform set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA' limit 1),true);
end $$;
set local role authenticated;
do $$
declare product uuid; linked_item uuid; asin_item uuid; before_model text; missing_count integer;
begin
  if exists (select 1 from app.v_inventory_display a join app.v_delivery_tasks d using(id)
      where a.model_no is distinct from d.model_no or a.asin is distinct from d.asin
        or a.title is distinct from d.title or a.tracking_no is distinct from d.tracking_no
        or a.status is distinct from d.status or a.condition is distinct from d.condition
        or a.deliverer_id is distinct from d.deliverer_id or a.planned_price is distinct from d.planned_price
        or a.accessories is distinct from d.accessories or a.purchased_at is distinct from d.purchased_at) then
    raise exception 'Shared item information differs between apps';
  end if;
  if (select count(*) from app.v_delivery_tasks) <> (select count(distinct id) from app.v_delivery_tasks) then
    raise exception 'Catalog fallback duplicated inventory rows';
  end if;
  select p.id,p.model_no,i.id into product,before_model,asin_item from app.items i
    join app.products p on p.asin=i.asin where i.product_id is null and i.marketplace::text='動作品Amazon返品' limit 1;
  select id into linked_item from app.items where product_id=product limit 1;
  if product is null or linked_item is null then raise exception 'Linked and ASIN fixtures missing'; end if;
  update app.products set model_no='MODEL-SYNC-ROLLBACK-ONLY' where id=product;
  if exists(select 1 from app.v_inventory_display where id in (linked_item,asin_item) and model_no is distinct from 'MODEL-SYNC-ROLLBACK-ONLY')
      or exists(select 1 from app.v_delivery_tasks where id in (linked_item,asin_item) and model_no is distinct from 'MODEL-SYNC-ROLLBACK-ONLY') then
    raise exception 'Catalog edit did not reach both apps and both link paths';
  end if;
  update app.products set model_no=null where id=product;
  if exists(select 1 from app.v_delivery_tasks where id=asin_item and model_no is not null) then
    raise exception 'FNSKU/title was substituted for an unregistered model';
  end if;
  update app.products set model_no=before_model where id=product;
  select count(*) into missing_count from app.v_delivery_tasks where marketplace::text='動作品Amazon返品' and model_no is null;
  raise notice 'Shared data, exact catalog linkage, live model edits, and missing models passed (% missing)',missing_count;
end $$;
reset role;
do $$ begin
  perform set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.role='deliverer' and s.is_active limit 1),true);
end $$;
set local role authenticated;
do $$ begin
  if exists(select 1 from app.v_delivery_tasks where deliverer_id is distinct from app.current_staff_id()) then
    raise exception 'Delivery staff can access an unassigned item';
  end if;
  if has_table_privilege('anon','app.v_delivery_tasks','select') or has_table_privilege('anon','app.v_items','select') then
    raise exception 'Views exposed to anonymous users';
  end if;
end $$;
rollback;
select 'Model sync and delivery RLS verified; all fixture changes rolled back' as result;
