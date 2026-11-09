create function app.assign_product_catalog_number()
returns trigger
language plpgsql
set search_path = pg_catalog, app
as $function$
begin
  if tg_level = 'STATEMENT' then
    -- Coordinate registrations and explicit number changes before locking any rows.
    perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));
    return null;
  end if;

  select greatest(coalesce(max(product_no), 0), 0) + 1
    into new.product_no
    from app.products;
  return new;
end;
$function$;

create trigger products_lock_catalog_number
before insert or update of product_no on app.products
for each statement execute function app.assign_product_catalog_number();

create trigger products_assign_catalog_number
before insert on app.products
for each row when (new.product_no is null)
execute function app.assign_product_catalog_number();

revoke all on function app.assign_product_catalog_number() from public, anon, authenticated;
