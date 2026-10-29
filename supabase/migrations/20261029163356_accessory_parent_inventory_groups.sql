-- Group delivery accessories by their recorded parent, while retaining legacy serial groups.
-- Both page readers remain security invoker; only parents visible in the same raw view can join.
do $migration$
declare definition text; function_name text; old_serial text:=$old$coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq')$old$;
 new_serial text:=$new$coalesce(case when $1='delivery' then lower(substring(parent.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')) end,lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq')$new$;
begin
 foreach function_name in array array['app.read_inventory_page(text,jsonb,integer,jsonb)','app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'] loop
  definition:=pg_get_functiondef(function_name::regprocedure);
  if position('inventory_group_serial' in definition)>0 then continue;end if;
  if position(old_serial in definition)=0 or position('from raw r left join origins o' in definition)=0 or position('''original_marketplace_item_id'',o.item_id' in definition)=0 then raise exception 'Parent grouping insertion point missing: %',function_name;end if;
  definition:=replace(definition,'''original_marketplace_item_id'',o.item_id',
   '''inventory_group_serial'','||new_serial||',''original_marketplace_item_id'',o.item_id');
  -- Only the serial expression in the data CTE has the exact original form.
  definition:=replace(definition,old_serial||' serial',new_serial||' serial');
  definition:=replace(definition,'from raw r left join origins o',$join$from raw r
   left join app.items relation on $1='delivery' and (r.d->>'is_accessory')::boolean and relation.id=(r.d->>'id')::uuid
   left join raw parent on parent.d->>'id'=relation.parent_item_id::text and not (parent.d->>'is_accessory')::boolean
   left join origins o$join$);
  execute definition;
 end loop;
end $migration$;
