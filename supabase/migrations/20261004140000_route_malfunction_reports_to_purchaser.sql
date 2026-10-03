create or replace function app.resolve_item_malfunction(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare current_staff uuid:=app.current_staff_id();
begin
  if auth.uid() is null or not (
    app.is_admin()
    or (app.current_role()='purchaser' and exists (
      select 1 from app.items i where i.id=p_item_id and i.purchaser_id=current_staff
    ))
  ) then
    raise exception '対象商品の仕入担当者または管理者のみ対応できます' using errcode='42501';
  end if;
  update app.items set malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=current_staff
  where id=p_item_id and malfunction_reported and malfunction_resolved_at is null;
  if not found then raise exception '未対応の動作不良報告が見つかりません' using errcode='P0002'; end if;
end $$;
revoke all on function app.resolve_item_malfunction(uuid) from public,anon,authenticated;
grant execute on function app.resolve_item_malfunction(uuid) to authenticated;
