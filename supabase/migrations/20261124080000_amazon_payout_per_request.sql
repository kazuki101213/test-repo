-- 2026-11-24: Amazon振込を「支払いリクエスト（振込グループ）ごと」に返す。
-- 最新1件だけでなく、締まった振込を新しい順に最大20件（90日以内）返す。
-- 内訳・担当者・料金の扱いは 20261124070000 と同じ。ただし DebtRecovery は、前回の振込のマイナス分の精算だけを除く
-- （同じ振込の中の料金をすぐ精算したものは料金と打ち消し合うので残す）。

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
    with payouts as (
      select g.*
      from app.amazon_payout_groups g
      where g.processing_status = 'Closed' and g.group_start is not null and g.group_end is not null
        and g.group_end >= now() - interval '90 days'
      order by g.group_end desc
      limit 20
    ), released as (
      select g.account_key as group_account, g.group_id, g.account_label, t.transaction_id, t.posted_at,
        t.transaction_type, t.description, t.amount, t.order_id,
        coalesce(
          (select x->>'sku' from jsonb_array_elements(t.item_breakdowns) x where x->>'sku' is not null limit 1),
          (select x->>'sku' from app.amazon_payment_transactions o, jsonb_array_elements(o.item_breakdowns) x
            where t.order_id is not null and o.account_key = t.account_key and o.order_id = t.order_id
              and x->>'sku' is not null limit 1)
        ) as sku
      from payouts g
      left join lateral (
        select p.total from app.amazon_payout_groups p
        where p.account_key = g.account_key and p.group_end = g.group_start limit 1
      ) previous on true
      join app.amazon_payment_transactions t
        on t.account_key = g.account_key and t.status = 'RELEASED'
       and t.posted_at >= g.group_start and t.posted_at < g.group_end
      where coalesce(t.transaction_type, '') !~* '(transfer|disburse)'
        and coalesce(t.amount, 0) <> 0
        -- 前回の振込がマイナスだった分をカード等で精算した記録（DebtRecovery）は、今回の振込額に入らない。
        -- 同じ振込の中の料金をすぐ精算した DebtRecovery は、その料金と打ち消し合うので残す。
        and not (t.transaction_type = 'DebtRecovery' and coalesce(previous.total, 0) < 0 and t.amount = -previous.total)
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
          'line_total', coalesce((select sum(l.amount) from lines l where l.group_account = g.account_key and l.group_id = g.group_id), 0),
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
            from lines l where l.group_account = g.account_key and l.group_id = g.group_id), '[]'::jsonb)
        ) order by g.group_end desc)
        from payouts g), '[]'::jsonb)
    )
  );
end;
$$;

notify pgrst, 'reload schema';
