-- Amazon1 is currently suspended. Keep the last report for future recovery.
alter table app.amazon_seller_inventory_sync add column account_suspended boolean not null default false;
update app.amazon_seller_inventory_sync set account_suspended = true where account_id = 'amazon-1';

do $migration$
declare
  definition text;
  updated text;
  report_job text;
  report_schedule text;
begin
  definition := pg_get_functiondef('app.claim_seller_inventory_report(text,boolean)'::regprocedure);
  updated := replace(definition, 'where s.account_id = p_account', 'where s.account_id = p_account and not s.account_suspended');
  if updated = definition then raise exception 'Amazon report claim filter missing'; end if;
  execute updated;

  definition := pg_get_functiondef('app.read_amazon_listing_sync_status()'::regprocedure);
  updated := replace(definition, 'order by s.account_id;', 'where not s.account_suspended order by s.account_id;');
  if updated = definition then raise exception 'Amazon report status filter missing'; end if;
  execute updated;

  select command, schedule into report_job, report_schedule
  from cron.job where jobname = 'amazon-seller-inventory-refresh';
  if report_job is not null then
    updated := replace(report_job, 'where (s.lease_until', 'where not s.account_suspended and (s.lease_until');
    if updated = report_job then raise exception 'Amazon report cron filter missing'; end if;
    perform cron.schedule('amazon-seller-inventory-refresh', report_schedule, updated);
  end if;
end
$migration$;
notify pgrst, 'reload schema';
