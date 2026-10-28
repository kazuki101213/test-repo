-- Formalize the extension's existing admin-only reservation ledger on clean databases.
alter table app.marketplace_extension_receipts enable row level security;
revoke all on app.marketplace_extension_receipts from public,anon;
grant select,insert,update,delete on app.marketplace_extension_receipts to authenticated;
do $policy$
begin
 if not exists(select 1 from pg_policies where schemaname='app' and tablename='marketplace_extension_receipts' and policyname='marketplace_extension_receipts_admin') then
  execute 'create policy marketplace_extension_receipts_admin on app.marketplace_extension_receipts for all to authenticated using(app.is_admin()) with check(app.is_admin())';
 end if;
end $policy$;
