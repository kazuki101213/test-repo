-- Yoshimitsu's 400-yen trial rate also applies to the October 2026 invoice.
do $correction$
declare
  owner_user uuid;
  yoshimitsu uuid;
  invoice app.delivery_invoices;
  saved app.delivery_invoices;
  fresh jsonb;
  expected_lines jsonb;
begin
  select id into yoshimitsu from app.staff where code='MM';
  if yoshimitsu is null then return; end if;
  perform set_config('lock_timeout','3s',true);
  perform pg_advisory_xact_lock(hashtextextended(yoshimitsu::text||date '2026-10-01'::text,0));
  select * into invoice from app.delivery_invoices where staff_id=yoshimitsu and billing_month=date '2026-10-01' for update;
  if not found then
    update app.delivery_invoice_profiles set category_rates=jsonb_set(category_rates,'{from_month}','"2026-10-01"'::jsonb,false)
    where staff_id=yoshimitsu and category_rates='{"from_month":"2026-11-01","monitor":450,"bluray":500,"trial":400}'::jsonb;
    return;
  end if;
  select p.user_id into strict owner_user from app.profiles p join app.staff s on s.id=p.staff_id
  where s.code='AA' and s.role='admin' and s.is_active;
  perform set_config('request.jwt.claim.sub',owner_user::text,true);
  if invoice.version<>6 or invoice.total<>25270 or invoice.review_content is not null
    or exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice.id) then
    raise exception 'Unexpected invoice state';
  end if;
  select jsonb_agg(jsonb_set(jsonb_set(line,'{unit_price}','400'::jsonb),'{amount}',to_jsonb(400*(line->>'quantity')::integer)) order by n)
  into expected_lines from jsonb_array_elements(invoice.snapshot->'lines') with ordinality x(line,n);
  update app.delivery_invoice_profiles set category_rates=jsonb_set(category_rates,'{from_month}','"2026-10-01"'::jsonb,false)
  where staff_id=invoice.staff_id and category_rates='{"from_month":"2026-11-01","monitor":450,"bluray":500,"trial":400}'::jsonb;
  if not found then raise exception 'Unexpected category rate settings'; end if;
  fresh:=app.prepare_delivery_invoice(invoice.staff_id,invoice.billing_month);
  if fresh->'lines' is distinct from expected_lines or fresh->'profile' is distinct from invoice.snapshot->'profile'
    or fresh->'tax_percent' is distinct from invoice.snapshot->'tax_percent'
    or (fresh->>'subtotal')::bigint<>13200
    or app.invoice_receipt_lines(invoice.staff_id,invoice.billing_month) is distinct from invoice.snapshot->'receipt_lines' then
    raise exception 'A change other than unit price was detected';
  end if;
  -- Keep the normal invoice and receipt calculations. Suppress only the new push for this correction.
  if not exists(select 1 from pg_trigger where tgrelid='app.delivery_invoices'::regclass
    and tgname='invoices_admin_push' and tgenabled='O') then
    raise exception 'Unexpected invoice notification trigger state';
  end if;
  alter table app.delivery_invoices disable trigger invoices_admin_push;
  update app.delivery_invoices set extras=invoice.extras
  where id=invoice.id and version=invoice.version returning * into strict saved;
  alter table app.delivery_invoices enable trigger invoices_admin_push;
  if saved.version<>invoice.version+1 or saved.total<>21970
    or saved.snapshot->'lines' is distinct from expected_lines
    or saved.snapshot->'receipt_lines' is distinct from invoice.snapshot->'receipt_lines'
    or saved.extras is distinct from invoice.extras or saved.note is distinct from invoice.note
    or saved.issued_on is distinct from invoice.issued_on then
    raise exception 'Unexpected recalculated invoice';
  end if;
end $correction$;
