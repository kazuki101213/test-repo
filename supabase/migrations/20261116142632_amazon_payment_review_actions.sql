create table app.amazon_payment_review_resolutions (
  account_key text not null,
  marketplace_id text not null,
  transaction_id text not null,
  resolution text not null check (resolution in ('dismissed', 'settlement_confirmed')),
  resolved_by uuid not null,
  resolved_at timestamptz not null default now(),
  primary key (account_key, marketplace_id, transaction_id),
  foreign key (account_key, marketplace_id, transaction_id)
    references app.amazon_payment_transactions (account_key, marketplace_id, transaction_id)
);
alter table app.amazon_payment_review_resolutions enable row level security;
revoke all on app.amazon_payment_review_resolutions from public, anon, authenticated;
grant select, insert on app.amazon_payment_review_resolutions to service_role;

create or replace view app.v_amazon_unreflected_payments
with (security_invoker = true) as
select
  t.account_key,
  t.marketplace_id,
  t.transaction_id,
  (t.posted_at at time zone 'Asia/Tokyo')::date as transaction_day,
  t.posted_at,
  t.transaction_type,
  t.description,
  t.amount,
  t.currency,
  linked.matched_items > 0 as partially_reflected,
  t.status
from app.amazon_payment_transactions t
cross join lateral (
  select
    count(*) as total_items,
    count(distinct (item.value ->> 'sku')) filter (
      where
        exists (
          select 1 from app.amazon_sale_matches s
          where s.account_key = t.account_key and s.transaction_id = t.transaction_id
            and s.sku = item.value ->> 'sku'
        )
        or exists (
          select 1 from app.amazon_refund_matches r
          where r.account_key = t.account_key and r.marketplace_id = t.marketplace_id
            and r.transaction_id = t.transaction_id and r.sku = item.value ->> 'sku'
        )
    ) as matched_items
  from jsonb_array_elements(t.item_breakdowns) item
) linked
where t.marketplace_id = 'A1VC38T7YXB528'
  and t.status in ('RELEASED', 'DEFERRED_RELEASED', '支払い実行済み')
  and t.amount is distinct from 0
  and not exists (
    select 1 from app.amazon_fee_expense_links f
    where f.account_key = t.account_key and f.marketplace_id = t.marketplace_id
      and f.transaction_id = t.transaction_id
  )
  and not exists (
    select 1 from app.amazon_payment_review_resolutions r
    where r.account_key = t.account_key and r.marketplace_id = t.marketplace_id
      and r.transaction_id = t.transaction_id
  )
  and linked.matched_items < greatest(linked.total_items, 1);

create or replace view app.v_expense_reimbursements with (security_invoker = true) as
select r.id, r.spent_on, r.staff_id, r.description, r.category, r.amount,
       a.approved_at is not null as approved,
       e.id is not null as included_in_expense,
       r.billing_month
from app.invoice_receipts r
left join app.delivery_invoices i on i.staff_id = r.staff_id and i.billing_month = r.billing_month
left join app.delivery_invoice_approvals a on a.invoice_id = i.id
left join app.expenses e on e.id = a.expense_id and e.deleted_at is null
where app.is_admin() and r.include_in_invoice and r.document_type <> 'invoice'
  and r.spent_on is not null and r.amount is not null;

create function app.packed_product_summary(p_staff uuid, p_month date, p_month_count integer)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, app as $$
declare result jsonb;
begin
  if auth.uid() is null or not coalesce(p_staff = app.current_staff_id() or app.is_admin(), false)
    or not exists (select 1 from app.staff where id = app.current_staff_id() and is_active) then
    raise exception '閲覧する権限がありません' using errcode = '42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1 or p_month_count is null or p_month_count not between 1 and 6 then
    raise exception '対象期間が不正です' using errcode = '22023';
  end if;
  with bodies as (
    select distinct on (app.product_serial(sku, lot_seq)) id, lot_seq, purchased_at, packed_on, title, sku
    from app.items
    where deliverer_id = p_staff and not is_accessory and packed_on is not null
    order by app.product_serial(sku, lot_seq), packed_on, id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'lot_seq', lot_seq, 'purchased_at', purchased_at, 'packed_on', packed_on, 'title', title, 'sku', sku
  ) order by packed_on desc, lot_seq desc), '[]'::jsonb)
  into result from bodies
  where packed_on >= p_month and packed_on < p_month + make_interval(months => p_month_count);
  return result;
end $$;

revoke all on function app.packed_product_summary(uuid, date, integer) from public, anon, authenticated;
grant execute on function app.packed_product_summary(uuid, date, integer) to authenticated;
notify pgrst, 'reload schema';
