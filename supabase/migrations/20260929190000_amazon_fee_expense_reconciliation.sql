create table if not exists app.amazon_fee_expense_links (
  account_key text not null,
  marketplace_id text not null,
  transaction_id text not null,
  expense_id uuid unique references app.expenses(id) on delete restrict,
  resolution text not null check (resolution in ('matched_existing','created','zero','cancelled','superseded')),
  created_at timestamptz not null default now(),
  primary key (account_key, marketplace_id, transaction_id),
  foreign key (account_key, marketplace_id, transaction_id)
    references app.amazon_payment_transactions(account_key, marketplace_id, transaction_id) on delete restrict
);
create index if not exists amazon_fee_expense_links_expense_idx on app.amazon_fee_expense_links(expense_id);
alter table app.amazon_fee_expense_links enable row level security;
revoke all on app.amazon_fee_expense_links from anon, authenticated;
grant select on app.amazon_fee_expense_links to authenticated;
grant select, insert, update on app.amazon_fee_expense_links to service_role;
drop policy if exists amazon_fee_expense_links_admin_read on app.amazon_fee_expense_links;
create policy amazon_fee_expense_links_admin_read on app.amazon_fee_expense_links
  for select to authenticated using ((select app.is_admin()));
