-- Remove retired states from all live filtering/summary views. Preserve
-- column order, existing view options and grants; historical migrations remain.
do $$
declare view_name text; definition text;
begin
  if exists(select 1 from app.items where status::text in ('仕入済','入荷済')) then
    raise exception 'Unexpected retired statuses; reconcile fixed item IDs before applying';
  end if;
  foreach view_name in array array['v_delivery_tasks','v_deliverer_workload','v_stock_summary'] loop
    definition:=pg_get_viewdef(('app.'||view_name)::regclass,true);
    definition:=replace(definition,'''仕入済''::app.item_status, ''入荷済''::app.item_status, ', '');
    -- Compatibility column is unused by either app. Never count retired states.
    definition:=replace(definition,'status = ''仕入済''::app.item_status','false');
    execute 'create or replace view app.'||quote_ident(view_name)||' as '||definition;
  end loop;
end $$;
alter table app.items add constraint items_no_retired_purchase_status
  check(status::text not in ('仕入済','入荷済'));
