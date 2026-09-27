
create table app.invoice_receipt_submissions (
 staff_id uuid not null references app.delivery_invoice_profiles(staff_id),
 billing_month date not null check(extract(day from billing_month)=1),
 files jsonb not null,
 version integer not null default 1,
 submitted_at timestamptz not null default now(),
 primary key(staff_id,billing_month)
);
alter table app.invoice_receipt_submissions enable row level security;
revoke all on app.invoice_receipt_submissions from public,anon,authenticated;
grant select on app.invoice_receipt_submissions to authenticated;
grant insert(staff_id,billing_month) on app.invoice_receipt_submissions to authenticated;
grant update(submitted_at) on app.invoice_receipt_submissions to authenticated;
create policy receipt_submissions_read on app.invoice_receipt_submissions for select to authenticated
 using((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active));
create policy receipt_submissions_insert on app.invoice_receipt_submissions for insert to authenticated
 with check((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active));
create policy receipt_submissions_update on app.invoice_receipt_submissions for update to authenticated
 using((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active))
 with check((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active));
create trigger a_lock_receipt_submission before insert or update on app.invoice_receipt_submissions for each row execute function app.lock_invoice_receipt_changes();
create function app.fill_receipt_submission() returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'storage_path',storage_path,'original_name',original_name) order by created_at,id),'[]'::jsonb)
 into new.files from app.invoice_receipts where staff_id=new.staff_id and billing_month=new.billing_month;
 if jsonb_array_length(new.files)=0 then raise exception '領収書の画像を追加してください'; end if;
 new.submitted_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_receipt_submission() from public,anon,authenticated;
create trigger fill_receipt_submission before insert or update on app.invoice_receipt_submissions for each row execute function app.fill_receipt_submission();

create function app.submit_invoice_documents(p_staff uuid,p_month date,p_invoice boolean,p_receipts boolean,p_issued date,p_extras jsonb,p_note text,p_version integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; receipt_version integer;
begin
 if auth.uid() is null or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false)
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '送信する権限がありません' using errcode='42501'; end if;
 if not coalesce(p_invoice,false) and not coalesce(p_receipts,false) then raise exception '送信する書類を選択してください'; end if;
 -- Serialize invoice and receipt-only submissions for this staff/month.
 perform pg_advisory_xact_lock(hashtextextended(p_staff::text||p_month::text,0));
 if p_invoice then
  select * into inv from app.delivery_invoices where staff_id=p_staff and billing_month=p_month for update;
  if found then
   if p_version is null or inv.version<>p_version then raise exception '請求書が更新されています。再読み込みしてください'; end if;
   update app.delivery_invoices set issued_on=p_issued,extras=p_extras,note=p_note where id=inv.id returning * into inv;
  else
   if p_version is not null then raise exception '請求書を再読み込みしてください'; end if;
   insert into app.delivery_invoices(staff_id,billing_month,issued_on,extras,note) values(p_staff,p_month,p_issued,p_extras,p_note) returning * into inv;
  end if;
 end if;
 if p_receipts then
  insert into app.invoice_receipt_submissions(staff_id,billing_month) values(p_staff,p_month)
  on conflict(staff_id,billing_month) do update set submitted_at=clock_timestamp()
  returning version into receipt_version;
 end if;
 return jsonb_build_object('invoice',case when p_invoice then to_jsonb(inv) else null end,'receipt_version',receipt_version);
end $$;
revoke all on function app.submit_invoice_documents(uuid,date,boolean,boolean,date,jsonb,text,integer) from public,anon,authenticated;
grant execute on function app.submit_invoice_documents(uuid,date,boolean,boolean,date,jsonb,text,integer) to authenticated;
notify pgrst,'reload schema';

