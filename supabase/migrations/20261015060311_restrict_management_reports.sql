-- Management-only reports must also be protected at the Data API boundary.
-- Inventory and spares retain their existing RLS and editing rules.
create or replace function app.management_reports_allowed() returns boolean
language sql stable security invoker set search_path = ''
as $$ select coalesce(app.current_role() = 'admin', false) $$;
revoke all on function app.management_reports_allowed() from public,anon;
grant execute on function app.management_reports_allowed() to authenticated;
do $$
declare report_name text; definition text;
begin
  foreach report_name in array array['v_monthly_summary','v_stock_summary','v_deliverer_workload','v_antique_ledger','v_ledger_gaps','v_product_performance'] loop
    definition := pg_get_viewdef(format('app.%I',report_name)::regclass,true);
    if position('management_reports_allowed' in definition) = 0 then
      execute format('create or replace view app.%I with (security_invoker=true,security_barrier=true) as select report.* from (%s) report where (select app.management_reports_allowed())',report_name,rtrim(btrim(definition),';'));
    end if;
  end loop;
end $$;
notify pgrst,'reload schema';
