create table if not exists app.amazon_order_history (
  account_key text not null,
  order_item_id text not null,
  order_id text not null,
  ordered_at timestamptz not null,
  order_status text not null,
  fulfillment_channel text,
  sku text,
  asin text,
  quantity integer,
  currency text,
  item_price numeric,
  item_tax numeric,
  shipping_price numeric,
  shipping_tax numeric,
  promotion_discount numeric,
  source_report text not null,
  imported_at timestamptz not null default now(),
  primary key (account_key, order_item_id),
  check (quantity is null or quantity >= 0)
);
create index if not exists amazon_order_history_ordered_idx on app.amazon_order_history (ordered_at desc);
create index if not exists amazon_order_history_sku_idx on app.amazon_order_history (sku);
alter table app.amazon_order_history enable row level security;
revoke all on app.amazon_order_history from anon, authenticated;
grant select on app.amazon_order_history to authenticated;
grant select, insert, update on app.amazon_order_history to service_role;
drop policy if exists amazon_order_history_admin_read on app.amazon_order_history;
create policy amazon_order_history_admin_read on app.amazon_order_history
  for select to authenticated using ((select app.is_admin()));
comment on table app.amazon_order_history is 'Sanitized Amazon Seller Central all orders history. No buyer information or addresses. Existing app sale records are not overwritten.';

create table if not exists app.amazon_order_report_batches (
  account_key text not null,
  report_id text not null,
  starts_on date not null,
  ends_on date not null,
  row_count integer not null,
  imported_at timestamptz not null default now(),
  primary key(account_key,report_id),
  check (starts_on <= ends_on),
  check (row_count >= 0)
);
alter table app.amazon_order_report_batches enable row level security;
revoke all on app.amazon_order_report_batches from anon, authenticated;
grant select on app.amazon_order_report_batches to authenticated;
grant select,insert,update on app.amazon_order_report_batches to service_role;
drop policy if exists amazon_order_report_batches_admin_read on app.amazon_order_report_batches;
create policy amazon_order_report_batches_admin_read on app.amazon_order_report_batches
  for select to authenticated using ((select app.is_admin()));

create or replace view app.v_amazon_order_reconciliation with (security_invoker = true) as
with normalized as (
  select h.*,
    (h.ordered_at at time zone 'Asia/Tokyo')::date as order_on,
    case
      when h.sku ~ '^[A-Z]{2}-[0-9]+-[0-9]{8}-[0-9]+$'
        then split_part(h.sku,'-',2)||'-AA'||split_part(h.sku,'-',1)||'-'||split_part(h.sku,'-',3)||'-'||split_part(h.sku,'-',4)
      when h.sku ~ '^AA[A-Z]{2}-[0-9]+-[0-9]{8}-[0-9]+$'
        then split_part(h.sku,'-',2)||'-'||split_part(h.sku,'-',1)||'-'||split_part(h.sku,'-',3)||'-'||split_part(h.sku,'-',4)
      else h.sku
    end as canonical_sku
  from app.amazon_order_history h
), items_by_sku as (
  select sku, max(sold_on) as app_sold_on, max(sold_price) as app_sold_price, count(*) as app_row_count
  from app.items group by sku
), matched as (
  select n.*, i.app_sold_on, i.app_sold_price, i.app_row_count,
    count(*) filter (where n.order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and n.item_price is not null)
      over (partition by n.account_key, n.canonical_sku) as order_count_for_sku
  from normalized n left join items_by_sku i on i.sku=n.canonical_sku
)
select account_key, order_item_id, order_id, ordered_at, order_on, order_status, fulfillment_channel,
  sku, canonical_sku, asin, quantity, currency, item_price, item_tax, shipping_price, shipping_tax,
  promotion_discount, source_report, imported_at, app_sold_on, app_sold_price, app_row_count,
  order_count_for_sku,
  case
    when order_status not in ('Shipped','Delivered','Shipped - Delivered to Buyer') then '対象外'
    when item_price is null then '金額未確定'
    when quantity is distinct from 1 then '複数個'
    when app_row_count is null then '商品未登録'
    when order_count_for_sku > 1 then '同一SKU複数注文'
    when app_sold_on is null then 'アプリ未販売'
    when app_sold_price is distinct from item_price then '価格相違'
    when app_sold_on is distinct from order_on then '日付差'
    else '一致'
  end as reconciliation_status
from matched;
grant select on app.v_amazon_order_reconciliation to authenticated;
comment on view app.v_amazon_order_reconciliation is 'Administrator-only comparison of sanitized Amazon order report rows with inventory; source order data never overwrites inventory sales.';
