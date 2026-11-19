do $migration$
declare
  definition text;
  old text;
  new text;
begin
  definition := pg_get_viewdef('app.v_items'::regclass, true);
  old := E'i.seller_name,\n    i.seller_address,\n    i.untracked_shipping_method';
  new := E'NULL::text AS seller_name,\n    NULL::text AS seller_address,\n    NULL::text AS untracked_shipping_method';
  if strpos(definition, old) > 0 then
    execute 'create or replace view app.v_items as ' || replace(definition, old, new);
  end if;

  definition := pg_get_viewdef('app.v_inventory_display'::regclass, true);
  old := E'raw.seller_name,\n    raw.seller_address,\n    raw.untracked_shipping_method';
  new := $projection$CASE WHEN app.current_role() IN ('admin','purchaser') THEN raw.seller_name END AS seller_name,
    CASE WHEN app.current_role() IN ('admin','purchaser') THEN raw.seller_address END AS seller_address,
    raw.untracked_shipping_method$projection$;
  if strpos(definition, old) > 0 then
    execute 'create or replace view app.v_inventory_display as ' || replace(definition, old, new);
  end if;
end
$migration$;
