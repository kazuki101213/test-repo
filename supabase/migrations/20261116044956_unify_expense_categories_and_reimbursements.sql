alter type app.expense_category add value if not exists '配送費';
alter type app.expense_category add value if not exists '旅費交通費';
alter type app.expense_category add value if not exists '梱包資材費';
alter type app.expense_category add value if not exists '消耗品費';
alter type app.expense_category add value if not exists '支払手数料';
alter type app.expense_category add value if not exists '研修費';
alter type app.expense_category add value if not exists '保管料';

create view app.v_expense_reimbursements with (security_invoker = true) as
select r.id, r.spent_on, r.staff_id, r.description, r.category, r.amount,
       a.approved_at is not null as approved,
       e.id is not null as included_in_expense
from app.invoice_receipts r
left join app.delivery_invoices i on i.staff_id = r.staff_id and i.billing_month = r.billing_month
left join app.delivery_invoice_approvals a on a.invoice_id = i.id
left join app.expenses e on e.id = a.expense_id and e.deleted_at is null
where app.is_admin() and r.include_in_invoice and r.document_type <> 'invoice'
  and r.spent_on is not null and r.amount is not null;

revoke all on app.v_expense_reimbursements from public, anon;
grant select on app.v_expense_reimbursements to authenticated;
notify pgrst,'reload schema';
