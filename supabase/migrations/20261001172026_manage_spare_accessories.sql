-- Let administrators manage the shared spare ledger, and purchasers manage only their own spares.
grant insert, update on app.spare_accessories to authenticated;

create policy spare_accessories_insert on app.spare_accessories
  for insert to authenticated
  with check (
    app.is_admin()
    or (app.current_role() = 'purchaser' and owner_staff_id = app.current_staff_id())
  );

create policy spare_accessories_update on app.spare_accessories
  for update to authenticated
  using (
    app.is_admin()
    or (app.current_role() = 'purchaser' and owner_staff_id = app.current_staff_id())
  )
  with check (
    app.is_admin()
    or (app.current_role() = 'purchaser' and owner_staff_id = app.current_staff_id())
  );
