insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('invoice-receipts','invoice-receipts',false,20971520,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
create table app.invoice_receipts (
 id uuid primary key default gen_random_uuid(),
 staff_id uuid not null references app.delivery_invoice_profiles(staff_id),
 billing_month date not null check(extract(day from billing_month)=1),
 storage_path text not null unique,
 original_name text not null check(length(original_name) between 1 and 255),
 created_at timestamptz not null default now(),
 check(storage_path ~ ('^'||staff_id::text||'/'||to_char(billing_month,'YYYY-MM')||'/[0-9a-f-]{36}\.jpg$'))
);
create index invoice_receipts_staff_month_idx on app.invoice_receipts(staff_id,billing_month,created_at);
alter table app.invoice_receipts enable row level security;
revoke all on app.invoice_receipts from public,anon,authenticated;
grant select,delete on app.invoice_receipts to authenticated;
grant insert(staff_id,billing_month,storage_path,original_name) on app.invoice_receipts to authenticated;
create function app.can_access_invoice_receipt(p_path text,p_write boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,app as $$
 select auth.uid() is not null
 and (split_part(p_path,'/',1)=app.current_staff_id()::text or app.is_admin())
 and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.delivery_invoice_profiles p where p.staff_id::text=split_part(p_path,'/',1))
 and split_part(p_path,'/',2) ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 and (not p_write or not exists(
 select 1 from app.delivery_invoices i join app.delivery_invoice_approvals a on a.invoice_id=i.id
 where i.staff_id::text=split_part(p_path,'/',1) and to_char(i.billing_month,'YYYY-MM')=split_part(p_path,'/',2)
 ));
$$;
revoke all on function app.can_access_invoice_receipt(text,boolean) from public,anon,authenticated;
grant execute on function app.can_access_invoice_receipt(text,boolean) to authenticated;
create policy invoice_receipts_read on app.invoice_receipts for select to authenticated using(app.can_access_invoice_receipt(storage_path,false));
create policy invoice_receipts_insert on app.invoice_receipts for insert to authenticated with check(app.can_access_invoice_receipt(storage_path,true));
create policy invoice_receipts_delete on app.invoice_receipts for delete to authenticated using(app.can_access_invoice_receipt(storage_path,true));
create policy invoice_receipt_objects_read on storage.objects for select to authenticated
 using(bucket_id='invoice-receipts' and app.can_access_invoice_receipt(name,false));
create policy invoice_receipt_objects_insert on storage.objects for insert to authenticated
 with check(bucket_id='invoice-receipts' and app.can_access_invoice_receipt(name,true));
-- Uploaded image objects are immutable. Removing an attachment only removes its metadata.
create function app.lock_invoice_receipt_changes() returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare who uuid; target date; invoice uuid;
begin
 if tg_op='DELETE' then who:=old.staff_id; target:=old.billing_month; else who:=new.staff_id; target:=new.billing_month; end if;
 select id into invoice from app.delivery_invoices where staff_id=who and billing_month=target for update;
 if invoice is not null and exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice) then
  raise exception '承認済み請求書の領収書は変更できません';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function app.lock_invoice_receipt_changes() from public,anon,authenticated;
create trigger lock_invoice_receipt_changes before insert or delete on app.invoice_receipts for each row execute function app.lock_invoice_receipt_changes();
notify pgrst,'reload schema';
