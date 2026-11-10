-- Let PostgreSQL inline these pure SKU expressions during inventory rollups.
-- SQL-standard bodies bind the referenced functions and operator at definition
-- time, so no per-row search_path switch is needed.
create or replace function app.product_serial(p_sku text, p_lot_seq integer default null)
returns text language sql immutable parallel safe security invoker
return coalesce(pg_catalog.upper((pg_catalog.regexp_match(p_sku, '^([0-9]+[a-z]*)[-_]'))[1]), p_lot_seq::text);

create or replace function app.financial_product_serial(p_sku text, p_lot_seq integer)
returns text language sql immutable parallel safe security invoker
return pg_catalog.regexp_replace(pg_catalog.lower(app.product_serial(p_sku,p_lot_seq)), '^([0-9]+)[ab]+$', '\1');

create or replace function app.is_standalone_accessory_serial(p_sku text, p_lot_seq integer)
returns boolean language sql immutable parallel safe security invoker
return coalesce(pg_catalog.right(pg_catalog.lower(app.product_serial(p_sku,p_lot_seq)),1) operator(pg_catalog.=) 'c', false);
