create table app.amazon_payment_transactions (
  account_key text not null,
  marketplace_id text not null,
  transaction_id text not null,
  posted_at timestamptz not null,
  transaction_type text,
  status text,
  description text,
  amount numeric,
  currency text,
  order_id text,
  payment_date timestamptz,
  breakdowns jsonb not null default '[]'::jsonb,
  item_breakdowns jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null,
  primary key (account_key, marketplace_id, transaction_id),
  check (jsonb_typeof(breakdowns) = 'array'),
  check (jsonb_typeof(item_breakdowns) = 'array')
);
create index amazon_payments_history_idx on app.amazon_payment_transactions (account_key, marketplace_id, posted_at desc, transaction_id);
alter table app.amazon_payment_transactions enable row level security;
revoke all on app.amazon_payment_transactions from anon, authenticated;
grant select on app.amazon_payment_transactions to authenticated;
grant select, insert, update on app.amazon_payment_transactions to service_role;
create policy amazon_payments_admin_read on app.amazon_payment_transactions
for select to authenticated using ((select app.is_admin()));
comment on table app.amazon_payment_transactions is 'Amazon JP Finances transaction history. Service-side imports only. No Amazon writes.';
