alter table app.products
  add column owner_staff_id uuid references app.staff(id);

-- The existing catalog belongs to the original administrator.
update app.products
   set owner_staff_id = (select id from app.staff where code = 'AA')
 where owner_staff_id is null;

alter table app.products alter column owner_staff_id set not null;
create index products_owner_staff_id_idx on app.products (owner_staff_id);

create function app.set_product_catalog_owner()
returns trigger
language plpgsql
set search_path = pg_catalog, app
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.owner_staff_id is distinct from old.owner_staff_id and auth.uid() is not null then
      raise exception '商品リストの管理者は変更できません。' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.owner_staff_id is not null and auth.uid() is not null then
    raise exception '商品リストの管理者は自動で設定されます。' using errcode = '42501';
  end if;
  if new.owner_staff_id is null then
    if app.is_admin() then
      new.owner_staff_id := app.current_staff_id();
    else
      -- Existing imports and staff registration can continue without an owner field.
      select id into new.owner_staff_id from app.staff where code = 'AA';
    end if;
  end if;
  return new;
end;
$function$;

create trigger products_set_catalog_owner
before insert or update of owner_staff_id on app.products
for each row execute function app.set_product_catalog_owner();

revoke all on function app.set_product_catalog_owner() from public, anon, authenticated;
