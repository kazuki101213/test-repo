grant update(details,unit_price) on app.delivery_invoice_profiles to authenticated;
create policy invoice_profiles_update on app.delivery_invoice_profiles for update to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())))
 with check (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
notify pgrst,'reload schema';
