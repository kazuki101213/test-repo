-- Presentation-only parent metadata. The join uses the same authorized raw rows;
-- it does not change inventory scope, pagination, totals, SKU or sale fields.
do $migration$
declare definition text; function_name text; old_prefix text:='r.d || case when $1=''delivery'' then';
 new_prefix text:=$prefix$r.d || jsonb_build_object(
   'inventory_parent_serial',lower(substring(parent.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),
   'inventory_parent_status',parent.d->>'status',
   'inventory_parent_purchased_at',parent.d->>'purchased_at') || case when $1='delivery' then$prefix$;
begin
 foreach function_name in array array['app.read_inventory_page(text,jsonb,integer,jsonb)','app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'] loop
  definition:=pg_get_functiondef(function_name::regprocedure);
  if position('inventory_parent_status' in definition)>0 then continue;end if;
  if position(old_prefix in definition)=0 or position('left join app.items relation on $1=''delivery''' in definition)=0 then
   raise exception 'Inventory parent presentation insertion point missing: %',function_name;
  end if;
  definition:=replace(definition,old_prefix,new_prefix);
  definition:=replace(definition,'left join app.items relation on $1=''delivery''','left join app.items relation on $1 in (''delivery'',''management'')');
  execute definition;
 end loop;
end $migration$;
