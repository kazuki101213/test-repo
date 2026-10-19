-- A private projection exposes only delivery-card fields; base item RLS remains unchanged.
do $$
declare definition text; patched text;
begin
 definition:=rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),E';\n ');
 patched:=regexp_replace(definition,'app[.]is_admin\(\) OR [a-zA-Z_][a-zA-Z0-9_]*[.]deliverer_id = app[.]current_staff_id\(\)','true');
 if patched=definition then raise exception 'Delivery assignment predicate was not found';end if;
 execute 'create view app.v_delivery_catalog with(security_invoker=true) as '||patched;
 -- Reuse the existing paged/differential algorithm without changing its RLS-preserving public entry.
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 definition:=replace(definition,'app.read_inventory_page(','app.read_delivery_catalog_snapshot(');
 patched:=replace(definition,'''app.v_delivery_tasks''','''app.v_delivery_catalog''');
 if patched=definition then raise exception 'Delivery page source was not found';end if;
 execute patched;
end $$;
revoke all on app.v_delivery_catalog from public,anon,authenticated;
revoke all on function app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb) from public,anon,authenticated;

-- This is a separately authorized cross-assignee read, not a change to item SELECT/UPDATE policies.
create function app.read_delivery_catalog_page(p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active and role in ('admin','purchaser','deliverer')) then
  raise exception '権限がありません' using errcode='42501';
 end if;
 return app.read_delivery_catalog_snapshot('delivery',p_filters,p_limit,p_known);
end $$;
revoke all on function app.read_delivery_catalog_page(jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_delivery_catalog_page(jsonb,integer,jsonb) to authenticated;
notify pgrst,'reload schema';
