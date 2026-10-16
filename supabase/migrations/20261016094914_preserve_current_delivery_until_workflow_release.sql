-- Keep the currently published delivery state selector functional while the new
-- state-specific UI awaits release. The legacy zero-sale action stays management-only.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.set_inventory_workflow(uuid,app.item_status)'::regprocedure);
 if position('i.deliverer_id=actor' in definition)=0 then
  definition:=replace(definition,'app.is_admin() or','app.is_admin() or (i.deliverer_id=actor and p_status<>''販売済'') or');
  execute definition;
 end if;
end $$;
