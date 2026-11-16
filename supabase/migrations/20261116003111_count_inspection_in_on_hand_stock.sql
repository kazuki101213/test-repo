-- 検品中の商品は検品完了日時の有無を問わず手元に数える。
do $migration$
declare
  definition text := pg_get_viewdef('app.v_deliverer_stock_workload_items'::regclass, true);
  updated text := replace(
    definition,
    $condition$state.bucket = '検品中'::text AND i.inspected_at IS NOT NULL$condition$,
    $condition$state.bucket = '検品中'::text$condition$
  );
begin
  if updated = definition then
    raise exception 'Inspection condition not found in deliverer stock workload';
  end if;

  execute 'create or replace view app.v_deliverer_stock_workload_items
    with (security_invoker=true, security_barrier=true) as ' || updated;
end $migration$;

notify pgrst, 'reload schema';
