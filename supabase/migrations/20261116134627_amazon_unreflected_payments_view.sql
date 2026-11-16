create view app.v_amazon_unreflected_payments
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
  linked.matched_items > 0 as partially_reflected
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
  and linked.matched_items < greatest(linked.total_items, 1);

revoke all on app.v_amazon_unreflected_payments from public, anon, authenticated;
grant select on app.v_amazon_unreflected_payments to service_role;
notify pgrst, 'reload schema';
