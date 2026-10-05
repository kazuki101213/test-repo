drop policy if exists spare_accessories_delete on app.spare_accessories;
create policy spare_accessories_delete on app.spare_accessories
  for delete to authenticated
  using (
    used_for_item_id is null
    and (app.is_admin() or owner_staff_id = app.current_staff_id())
  );
