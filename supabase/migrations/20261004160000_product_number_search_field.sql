create or replace function app.product_no_search(app.products)
returns text
language sql
immutable
parallel safe
set search_path=pg_catalog,app
as $$
  select ($1).product_no::text
$$;

revoke all on function app.product_no_search(app.products) from public,anon;
grant execute on function app.product_no_search(app.products) to authenticated;

notify pgrst,'reload schema';
