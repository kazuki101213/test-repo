-- A spare may be registered as an accessory directly, rather than with a new main item.
-- Prefer that exact link over a match inherited through the parent.
do $migration$
declare
 definition text;
 function_name text;
 field_anchor text:=$field$'accessory_usage_note',spare.usage_note$field$;
 join_anchor text:=$join$left join origins o on$join$;
begin
 foreach function_name in array array['app.read_inventory_page(text,jsonb,integer,jsonb)','app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'] loop
  definition:=pg_get_functiondef(function_name::regprocedure);
  if position('direct_spare.usage_note' in definition)>0 then continue;end if;
  if position(field_anchor in definition)=0 or position(join_anchor in definition)=0 then
   raise exception 'Direct delivery accessory usage insertion point missing: %',function_name;
  end if;
  definition:=replace(definition,field_anchor,$field$'accessory_usage_note',coalesce(direct_spare.usage_note,spare.usage_note)$field$);
  definition:=replace(definition,join_anchor,$join$left join lateral (
    select min(btrim(s.usage_note)) usage_note
    from app.spare_accessories s
    where $1='delivery' and s.used_for_item_id=relation.id
      and s.marketplace=r.d->>'marketplace' and s.marketplace_item_id=r.d->>'marketplace_item_id'
      and nullif(btrim(s.usage_note),'') is not null
    having min(btrim(s.usage_note))=max(btrim(s.usage_note))
   ) direct_spare on true
   $join$||join_anchor);
  execute definition;
 end loop;
end $migration$;
