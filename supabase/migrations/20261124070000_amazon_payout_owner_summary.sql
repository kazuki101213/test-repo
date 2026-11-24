-- 2026-11-24: Amazonの振込（Finances の振込グループ）を保存し、ダッシュボードで
-- 「長部・石嶋」別の振込額と内訳（担当者・販売先）を見られるようにする。
-- 担当者は出品者SKUの仕入担当コードで決める。石川秀樹（EE）は長部一輝（AA）に含める
-- （dashboard_purchaser_ids と同じ扱い）。商品に結び付かない料金はアカウントの持ち主
-- （Amazon1＝長部、Amazon2＝石嶋）の分にする。

create table app.amazon_payout_groups (
  account_key text not null,
  group_id text not null,
  account_label text not null check (account_label in ('Amazon1', 'Amazon2')),
  processing_status text,
  fund_transfer_status text,
  total numeric,
  currency text,
  fund_transfer_date timestamptz,
  group_start timestamptz,
  group_end timestamptz,
  fetched_at timestamptz not null,
  primary key (account_key, group_id)
);
create index amazon_payout_groups_latest_idx on app.amazon_payout_groups (account_label, group_end desc);
alter table app.amazon_payout_groups enable row level security;
revoke all on app.amazon_payout_groups from anon, authenticated;
grant select on app.amazon_payout_groups to authenticated;
grant select, insert, update on app.amazon_payout_groups to service_role;
create policy amazon_payout_groups_admin_read on app.amazon_payout_groups
for select to authenticated using ((select app.is_admin()));
comment on table app.amazon_payout_groups is 'Amazon JP Finances の振込グループ（1回の振込）。サービス側の取り込みのみ。Amazonへは書き込まない。';

create or replace function app.amazon_payout_owner_code(p_sku text, p_account_label text)
returns text
language sql
immutable
set search_path to ''
as $$
  select case
    when code = 'EE' then 'AA'
    when code ~ '^[A-Z]{2}$' then code
    when p_account_label = 'Amazon2' then 'OO'
    else 'AA'
  end
  from (select substring(split_part(coalesce(p_sku, ''), '-', 2) from 1 for 2) as code) c;
$$;

create or replace function app.read_amazon_payout_summary()
returns jsonb
language plpgsql
stable
security invoker
set search_path to ''
as $$
begin
  if not coalesce(app.is_admin(), false) then
    raise exception '管理者でログインしてください。' using errcode = '42501';
  end if;
  return (
    with latest as (
      select distinct on (g.account_label) g.*
      from app.amazon_payout_groups g
      where g.processing_status = 'Closed' and g.group_start is not null and g.group_end is not null
      order by g.account_label, g.group_end desc
    ), released as (
      select g.account_label, g.group_id, t.transaction_id, t.posted_at, t.transaction_type, t.description,
        t.amount, t.order_id,
        coalesce(
          (select x->>'sku' from jsonb_array_elements(t.item_breakdowns) x where x->>'sku' is not null limit 1),
          (select x->>'sku' from app.amazon_payment_transactions o, jsonb_array_elements(o.item_breakdowns) x
            where t.order_id is not null and o.account_key = t.account_key and o.order_id = t.order_id
              and x->>'sku' is not null limit 1)
        ) as sku
      from latest g
      join app.amazon_payment_transactions t
        on t.account_key = g.account_key and t.status = 'RELEASED'
       and t.posted_at >= g.group_start and t.posted_at < g.group_end
      -- DebtRecovery は前回の不足分をカード等で精算した記録で、振込額には入らない。
      where coalesce(t.transaction_type, '') !~* '(transfer|disburse)' and t.transaction_type is distinct from 'DebtRecovery'
        and coalesce(t.amount, 0) <> 0
    ), lines as (
      select r.*,
        app.amazon_payout_owner_code(r.sku, r.account_label) as owner_code,
        (select coalesce(nullif(i.model_no, ''), i.title)
           from app.v_inventory_display i
          where i.sku = r.sku
             or (r.sku is not null and not i.is_accessory and i.lot_seq::text = split_part(r.sku, '-', 1))
          order by (i.sku = r.sku) desc, i.updated_at desc
          limit 1) as product,
        split_part(r.sku, '-', 1) as serial
      from released r
    )
    select jsonb_build_object(
      'owners', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name) order by s.code), '[]'::jsonb)
                 from app.staff s where s.code in ('AA', 'OO')),
      'payouts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'account', g.account_label,
          'group_id', g.group_id,
          'fund_transfer_status', g.fund_transfer_status,
          'fund_transfer_date', g.fund_transfer_date,
          'group_end', g.group_end,
          'total', g.total,
          'line_total', coalesce((select sum(l.amount) from lines l where l.account_label = g.account_label), 0),
          'lines', coalesce((
            select jsonb_agg(jsonb_build_object(
              'serial', l.serial,
              'product', l.product,
              'sku', l.sku,
              'type', l.transaction_type,
              'description', l.description,
              'owner_code', l.owner_code,
              'owner_name', (select s.name from app.staff s where s.code = l.owner_code and s.role in ('admin', 'purchaser') limit 1),
              'amount', l.amount
            ) order by (l.sku is null), l.serial, l.posted_at)
            from lines l where l.account_label = g.account_label), '[]'::jsonb)
        ) order by g.account_label)
        from latest g), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function app.amazon_payout_owner_code(text, text) from public, anon;
revoke all on function app.read_amazon_payout_summary() from public, anon;
grant execute on function app.amazon_payout_owner_code(text, text) to authenticated, service_role;
grant execute on function app.read_amazon_payout_summary() to authenticated;

-- 振込一覧は1時間ごとに取り込む（読み取りのみ。最新の振込の明細が未保存ならその期間だけ取り直す）。
select cron.schedule('amazon-payout-groups-sync', '40 * * * *', $job$
  select net.http_post(
    url := rtrim(config.project_url,'/') || '/functions/v1/amazon-payouts',
    headers := jsonb_build_object('Content-Type','application/json','x-amazon-cron-token',config.token),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  from (
    select
      (select decrypted_secret from vault.decrypted_secrets where name='delivery_push_project_url') project_url,
      (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token') token
  ) config
  where config.project_url is not null and config.token is not null;
$job$);

notify pgrst, 'reload schema';
