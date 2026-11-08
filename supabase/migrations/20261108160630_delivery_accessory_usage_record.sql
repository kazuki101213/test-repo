-- Show the recorded prior use of a transferred spare on its matching delivery accessory.
-- The inventory readers keep their current roles and only add this field to delivery rows.
do $migration$
declare
 definition text;
 function_name text;
 field_anchor text:=$field$'original_marketplace_item_id',o.item_id$field$;
 join_anchor text:=$join$left join origins o on$join$;
begin
 foreach function_name in array array['app.read_inventory_page(text,jsonb,integer,jsonb)','app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'] loop
  definition:=pg_get_functiondef(function_name::regprocedure);
  if position('accessory_usage_note' in definition)>0 then continue;end if;
  if position(field_anchor in definition)=0 or position(join_anchor in definition)=0 then
   raise exception 'Delivery accessory usage insertion point missing: %',function_name;
  end if;
  definition:=replace(definition,field_anchor,field_anchor||$field$,'accessory_usage_note',spare.usage_note$field$);
  definition:=replace(definition,join_anchor,$join$left join (
    select used_for_item_id,marketplace,marketplace_item_id,min(btrim(usage_note)) usage_note
    from app.spare_accessories
    where used_for_item_id is not null and nullif(btrim(usage_note),'') is not null
      and nullif(btrim(marketplace_item_id),'') is not null
    group by used_for_item_id,marketplace,marketplace_item_id
    having min(btrim(usage_note))=max(btrim(usage_note))
   ) spare on $1='delivery' and spare.used_for_item_id=relation.parent_item_id
    and spare.marketplace=r.d->>'marketplace' and spare.marketplace_item_id=r.d->>'marketplace_item_id'
   $join$||join_anchor);
  execute definition;
 end loop;
end $migration$;
