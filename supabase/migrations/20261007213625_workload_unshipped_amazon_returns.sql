-- Keep working Amazon returns in workload; exclude shipped returns.
-- Preserve all other metrics, view options, columns and grants.
do $$
declare definition text; old_condition text; new_condition text;
begin
  definition := pg_get_viewdef('app.v_deliverer_workload'::regclass, true);
  old_condition := 'i.status = ANY (ARRAY[''作業中''::app.item_status, ''Amazon返品''::app.item_status])';
  new_condition := '(i.status = ''作業中''::app.item_status OR (i.status = ''Amazon返品''::app.item_status AND i.shipped_on IS NULL))';
  if position(old_condition in definition) = 0 then
    raise exception 'Expected workload condition missing';
  end if;
  definition := replace(definition, old_condition, new_condition);
  execute 'create or replace view app.v_deliverer_workload as ' || definition;
end $$;
