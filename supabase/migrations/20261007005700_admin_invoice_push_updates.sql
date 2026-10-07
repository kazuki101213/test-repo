-- Invoice versions are assigned by a BEFORE trigger even when UPDATE targets note/extras.
drop trigger invoices_admin_push on app.delivery_invoices;
create trigger invoices_admin_push after insert or update on app.delivery_invoices
  for each row execute function app.capture_admin_push();
