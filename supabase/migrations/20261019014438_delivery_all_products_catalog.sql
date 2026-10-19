-- Cross-assignee catalog is a separate, strictly read-only projection.
-- It contains no costs, prices, payouts, descriptions, comments, messages or document data.
do $$
declare definition text; patched text;
begin
 definition:=rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),E';\n ');
 patched:=regexp_replace(definition,'app[.]is_admin\(\) OR [a-zA-Z_][a-zA-Z0-9_]*[.]deliverer_id = app[.]current_staff_id\(\)','true');
 if patched=definition then raise exception 'Delivery assignment predicate was not found';end if;
 -- No call to the work-authorized financial helper in this catalog.
 definition:=regexp_replace(patched,'app[.]shared_product_sale_values\(([a-zA-Z_][a-zA-Z0-9_]*)[.]id\)',
  '(select coalesce((select parent.sales_channel from app.items parent where \1.is_accessory and not app.is_standalone_accessory_serial(\1.sku,\1.lot_seq) and not parent.is_accessory and (parent.id=\1.parent_item_id or (\1.parent_item_id is null and parent.lot_seq=\1.lot_seq and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(\1.sku,\1.lot_seq))) limit 1),\1.sales_channel) sales_channel,null::bigint sold_price,null::bigint payout_amount)');
 if definition=patched then raise exception 'Financial display helper was not found';end if;
 execute 'create view app.v_delivery_catalog with(security_invoker=true) as select id,sku,lot_seq,is_accessory,status,work_stream,title,asin,condition,purchased_at,marketplace,tracking_no,sales_channel,deliverer_id,reference_image_url,marketplace_item_id,model_no,marketplace_url from ('||definition||') catalog_source';
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 definition:=replace(definition,'app.read_inventory_page(','app.read_delivery_catalog_snapshot(');
 patched:=replace(definition,'''app.v_delivery_tasks''','''app.v_delivery_catalog''');
 if patched=definition then raise exception 'Delivery page source was not found';end if;
 execute patched;
end $$;
revoke all on app.v_delivery_catalog from public,anon,authenticated;
revoke all on function app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb) from public,anon,authenticated;

-- The user authorized all delivery staff to browse other assignees' products.
-- Only active authenticated staff can invoke this fixed catalog path; no write API is changed.
create function app.read_delivery_catalog_page(p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active and role in ('admin','purchaser','deliverer')) then
  raise exception '権限がありません' using errcode='42501';
 end if;
 return app.read_delivery_catalog_snapshot('delivery',p_filters,p_limit,p_known);
end $$;
revoke all on function app.read_delivery_catalog_page(jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_delivery_catalog_page(jsonb,integer,jsonb) to authenticated;
notify pgrst,'reload schema';
