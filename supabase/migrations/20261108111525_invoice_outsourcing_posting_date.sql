-- Use the billing month from the locked invoice, including for older clients
-- that still supply the previous month-end date to the approval RPC.
create or replace function app.approve_delivery_invoice(p_invoice uuid,p_version integer,p_incurred_on date)
returns uuid language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; existing uuid; expense uuid;
begin
 if auth.uid() is null or not app.is_admin()
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '請求書を承認できるのは管理者だけです' using errcode='42501';
 end if;
 select * into inv from app.delivery_invoices where id=p_invoice for update;
 if not found then raise exception '請求書が見つかりません'; end if;
 select expense_id into existing from app.delivery_invoice_approvals where invoice_id=inv.id;
 if found then return existing; end if;
 if inv.version<>p_version then raise exception '請求書が更新されました。最新の内容を確認してください'; end if;
 if inv.total<=0 then raise exception '請求金額が0円のため承認できません'; end if;
 insert into app.expenses(incurred_on,category,name,amount,staff_id,memo)
 values((date_trunc('month',inv.billing_month::timestamp) + interval '1 month 9 days')::date,'外注費',
 coalesce(inv.snapshot->'profile'->>'issuer_name','納品担当者')||' '||to_char(inv.billing_month,'YYYY年MM月')||' 請求書',
 inv.total,inv.staff_id,'納品請求書 '||inv.id::text) returning id into expense;
 insert into app.delivery_invoice_approvals(invoice_id,expense_id) values(inv.id,expense);
 return expense;
end $$;

-- Move only active expenses created by the approval of an October invoice
-- that are still posted on the previous default date.
update app.expenses as expense
set incurred_on = date '2026-11-10'
from app.delivery_invoice_approvals as approval
join app.delivery_invoices as invoice on invoice.id = approval.invoice_id
where expense.id = approval.expense_id
  and invoice.billing_month = date '2026-10-01'
  and expense.category = '外注費'
  and expense.deleted_at is null
  and expense.incurred_on = date '2026-10-31';
