-- Usage notes describe historical allocation attempts, not whether a spare is available.
create or replace function app.allocate_spare_accessory(p_spare_id uuid, p_item_id uuid)
returns app.spare_accessories language plpgsql security definer set search_path = '' as $$
declare v_result app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備を割り当てる権限がありません' using errcode='42501';
  end if;
  if not exists (select 1 from app.items where id=p_item_id) then
    raise exception '割り当て先の商品が見つかりません' using errcode='22023';
  end if;
  update app.spare_accessories set used_for_item_id=p_item_id, updated_at=now()
    where id=p_spare_id and used_for_item_id is null
      and (app.is_admin() or owner_staff_id=app.current_staff_id())
    returning * into v_result;
  if not found then raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023'; end if;
  return v_result;
end $$;
