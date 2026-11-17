-- Amazon lists the parent SKU once. Keep its linked accessory rows visible in
-- management, but paginate and count them in the parent's listing group.
do $migration$
declare
  definition text := pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
  grouping text := $old$coalesce(case when $1='delivery' then lower(substring(parent.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')) end,lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq')$old$;
  management_parent text := $condition$($1='management'
    and r.d->>'status'='出品中'
    and r.d->>'sales_channel' in ('FBA','FBA1','FBA2','自己発送','自己発送1','自己発送2')
    and parent.d->>'status'=r.d->>'status'
    and parent.d->>'sales_channel'=r.d->>'sales_channel'
    and not app.is_standalone_accessory_serial(r.d->>'sku',(r.d->>'lot_seq')::integer))$condition$;
  parent_fields text := $anchor$'inventory_parent_serial',lower(substring(parent.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),$anchor$;
  new_grouping text;
begin
  if strpos(definition, grouping || ' serial')=0 or strpos(definition, parent_fields)=0 then
    raise exception 'Unexpected inventory grouping definition';
  end if;
  new_grouping := replace(grouping,$old$$1='delivery' then$old$,$new$$1='delivery' or $new$||management_parent||' then');
  definition := replace(definition,grouping||' serial',new_grouping||' serial');
  definition := replace(definition,parent_fields,parent_fields||'''inventory_group_serial'','||new_grouping||',');
  execute definition;
end $migration$;

notify pgrst,'reload schema';
