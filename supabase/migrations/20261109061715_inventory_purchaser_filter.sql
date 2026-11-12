-- Narrow each inventory scope before pagination without adding fields to its response.
do $migration$
declare
  definition text;
  function_name text;
  filter_anchor text := 'where app.inventory_page_matches(d,$2,$1)';
  validation_anchor text := ' -- Only whitelisted view names';
  purchaser_filter text := $filter$where app.inventory_page_matches(d,$2,$1)
   and case
    when coalesce($2->'purchaserIds','[]'::jsonb) = '[]'::jsonb then true
    else ($2->'purchaserIds') ? coalesce(d->>'purchaser_id', (
     select i.purchaser_id::text from app.items i where i.id=(d->>'id')::uuid
    ), '')
   end$filter$;
begin
  foreach function_name in array array[
    'app.read_inventory_page(text,jsonb,integer,jsonb)',
    'app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'
  ] loop
    definition := pg_get_functiondef(function_name::regprocedure);
    if position(purchaser_filter in definition) > 0 then continue; end if;
    if position(filter_anchor in definition) = 0 or position(validation_anchor in definition) = 0 then
      raise exception 'Inventory filter insertion point missing: %', function_name;
    end if;
    definition := replace(definition, validation_anchor,
      $check$ if p_filters ? 'purchaserIds' and jsonb_typeof(p_filters->'purchaserIds') is distinct from 'array' then
  raise exception '仕入担当者の条件が不正です' using errcode='22023';
 end if;
$check$ || validation_anchor);
    execute replace(definition, filter_anchor, purchaser_filter);
  end loop;
end $migration$;
