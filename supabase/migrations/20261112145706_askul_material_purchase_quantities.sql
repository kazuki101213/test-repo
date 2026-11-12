alter table app.expenses
  add column askul_item text,
  add column askul_quantity integer,
  add constraint expenses_askul_material_pair
    check (
      (askul_item is null and askul_quantity is null)
      or (
        askul_item is not null and askul_quantity is not null
        and length(btrim(askul_item)) between 1 and 200
      )
    );

create function app.fill_askul_material_quantities(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, app
as $$
declare
  affected integer;
begin
  if not coalesce(app.is_admin(), false) then
    raise exception '管理者権限が必要です。' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'アスクル明細の形式が不正です。' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) not between 1 and 250 or exists (
    select 1
    from jsonb_to_recordset(p_rows) as source(id uuid, item text, quantity integer)
    where id is null or item is null or length(btrim(item)) not between 1 and 200 or quantity is null
  ) then
    raise exception 'アスクル明細の内容が不正です。' using errcode = '22023';
  end if;

  update app.expenses expense
  set askul_item = source.item, askul_quantity = source.quantity
  from jsonb_to_recordset(p_rows) as source(id uuid, item text, quantity integer)
  where expense.id = source.id
    and expense.deleted_at is null
    and expense.memo like 'アスクル %'
    and expense.askul_quantity is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function app.fill_askul_material_quantities(jsonb) from public, anon;
grant execute on function app.fill_askul_material_quantities(jsonb) to authenticated;
