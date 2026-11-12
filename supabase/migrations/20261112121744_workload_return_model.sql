-- Legacy sellable Amazon returns may only have an ASIN link to the catalog.
do $migration$
declare
  definition text := pg_get_viewdef('app.v_deliverer_stock_workload_items'::regclass, true);
  updated text;
begin
  updated := replace(definition, '    p.model_no,', $model$
    COALESCE(p.model_no, CASE
      WHEN i.product_id IS NULL AND i.marketplace = '動作品Amazon返品' THEN
        (SELECT catalog.model_no FROM app.products catalog WHERE catalog.asin = i.asin)
    END) AS model_no,$model$);
  if updated = definition then
    raise exception 'Workload model column not found';
  end if;
  execute 'create or replace view app.v_deliverer_stock_workload_items
    with (security_invoker=true, security_barrier=true) as ' || updated;
end $migration$;

notify pgrst, 'reload schema';
