-- Receipt amounts are reimbursements including tax; they are added after invoice tax.
alter table app.invoice_receipts
 add column spent_on date,
 add column description text not null default '',
 add column amount bigint,
 add column payee text not null default '',
 add column memo text not null default '',
 add column include_in_invoice boolean not null default false,
 add column version integer not null default 1,
 add constraint invoice_receipt_detail_lengths check(length(description)<=200 and length(payee)<=200 and length(memo)<=2000),
 add constraint invoice_receipt_amount check(amount between 0 and 10000000),
 add constraint invoice_receipt_claim_complete check(not include_in_invoice or (document_type<>'invoice' and spent_on is not null and length(trim(description))>0 and amount is not null));
grant insert(spent_on,description,amount,payee,memo,include_in_invoice) on app.invoice_receipts to authenticated;
grant update(spent_on,description,amount,payee,memo,include_in_invoice) on app.invoice_receipts to authenticated;
create policy invoice_receipts_update on app.invoice_receipts for update to authenticated
 using(app.can_access_invoice_receipt(storage_path,true)) with check(app.can_access_invoice_receipt(storage_path,true));

create or replace function app.lock_invoice_receipt_changes() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare who uuid; target date; invoice uuid;
begin
 if tg_op='DELETE' then who:=old.staff_id; target:=old.billing_month; else who:=new.staff_id; target:=new.billing_month; end if;
 perform pg_advisory_xact_lock(hashtextextended(who::text||target::text,0));
 select id into invoice from app.delivery_invoices where staff_id=who and billing_month=target for update;
 if invoice is not null and exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice) then
  raise exception '承認済み請求書の領収書は変更できません';
 end if;
 if tg_op='UPDATE' and tg_table_name='invoice_receipts' then new.version:=old.version+1; end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger lock_invoice_receipt_changes on app.invoice_receipts;
create trigger lock_invoice_receipt_changes before insert or update or delete on app.invoice_receipts for each row execute function app.lock_invoice_receipt_changes();

create function app.invoice_receipt_lines(p_staff uuid,p_month date) returns jsonb
language sql stable security invoker set search_path=pg_catalog,app as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'date',spent_on,'spent_on',spent_on,'description',description,'quantity',1,'unit_price',amount,'amount',amount,
  'payee',payee,'memo',memo,'storage_path',storage_path,'original_name',original_name,'document_type',document_type,'mime_type',mime_type,
  'include_in_invoice',include_in_invoice,'version',version
 ) order by spent_on,created_at,id),'[]'::jsonb)
 from app.invoice_receipts where staff_id=p_staff and billing_month=p_month and include_in_invoice and document_type<>'invoice';
$$;
revoke all on function app.invoice_receipt_lines(uuid,date) from public,anon,authenticated;
grant execute on function app.invoice_receipt_lines(uuid,date) to authenticated;

create function app.fill_invoice_receipt_lines() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare lines jsonb; reimbursed bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.staff_id::text||new.billing_month::text,0));
 lines:=app.invoice_receipt_lines(new.staff_id,new.billing_month);
 select coalesce(sum((x->>'amount')::bigint),0) into reimbursed from jsonb_array_elements(lines) x;
 new.snapshot:=new.snapshot||jsonb_build_object('receipt_lines',lines,'receipt_subtotal',reimbursed);
 new.total:=new.total+reimbursed;
 return new;
end $$;
revoke all on function app.fill_invoice_receipt_lines() from public,anon,authenticated;
-- Runs after the existing calculation and approval lock triggers.
create trigger z_fill_invoice_receipt_lines before insert or update on app.delivery_invoices for each row execute function app.fill_invoice_receipt_lines();

create or replace function app.fill_receipt_submission() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'storage_path',storage_path,'original_name',original_name,'document_type',document_type,'mime_type',mime_type,
  'spent_on',spent_on,'description',description,'amount',amount,'payee',payee,'memo',memo,'include_in_invoice',include_in_invoice,'version',version
 ) order by created_at,id),'[]'::jsonb)
 into new.files from app.invoice_receipts where staff_id=new.staff_id and billing_month=new.billing_month and document_type in ('receipt','receipt_photo');
 if jsonb_array_length(new.files)=0 then raise exception '領収書または領収書の写真を追加してください'; end if;
 new.submitted_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;

create function app.check_invoice_receipts_on_approval() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices;
begin
 select * into inv from app.delivery_invoices where id=new.invoice_id for update;

 if coalesce(inv.snapshot->'receipt_lines','[]'::jsonb) is distinct from app.invoice_receipt_lines(inv.staff_id,inv.billing_month) then
  raise exception '領収書の明細が変更されています。請求書を再送信してから承認してください';
 end if;
 return new;
end $$;
revoke all on function app.check_invoice_receipts_on_approval() from public,anon,authenticated;
create trigger a_check_invoice_receipts before insert on app.delivery_invoice_approvals for each row execute function app.check_invoice_receipts_on_approval();
notify pgrst,'reload schema';