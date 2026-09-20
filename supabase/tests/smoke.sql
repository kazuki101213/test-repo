\set ON_ERROR_STOP on
-- 認証ユーザーとスタッフの紐付け
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'kubota@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'shinkawa@example.com');

insert into app.profiles (user_id, staff_id)
select '11111111-1111-1111-1111-111111111111', id from app.staff where code = 'AA';
insert into app.profiles (user_id, staff_id)
select '22222222-2222-2222-2222-222222222222', id from app.staff where code = 'DD';
insert into app.profiles (user_id, staff_id)
select '33333333-3333-3333-3333-333333333333', id from app.staff where code = 'HH';

insert into app.products (product_no, asin, model_no, maker, genre, list_price, payout_estimate, target_cost, turnover)
values (5, 'B01M1LIXM6', 'DMR-BRZ1020', 'Panasonic', '家電＆カメラ', 21980, 18683, 14199, '中');

\echo '--- [1] 管理者として仕入登録 (SKU 自動発番) ---'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

insert into app.items (lot_seq, purchaser_id, deliverer_id, purchased_at, title, cost_amount,
                       marketplace, marketplace_item_id, product_id, condition, planned_price,
                       planned_payout, sales_channel, work_stream)
select 2400,
       (select id from app.staff where code = 'AA'),
       (select id from app.staff where code = 'DD'),
       date '2026-09-16', 'DMR-BRZ1020', 12961, 'ヤフオク', 'q1234567890',
       (select id from app.products where asin = 'B01M1LIXM6'),
       '非常に良い', 21980, 18683, 'FBA', 'ブルーレイ';

-- 同じ通番号にぶら下がる付属品
insert into app.items (lot_seq, purchaser_id, deliverer_id, purchased_at, title, cost_amount,
                       marketplace, is_accessory)
select 2400,
       (select id from app.staff where code = 'AA'),
       (select id from app.staff where code = 'DD'),
       date '2026-09-24', 'リモコン', 1730, 'ヤフオク', true;

-- 別の納品担当者の商品
insert into app.items (lot_seq, purchaser_id, deliverer_id, purchased_at, title, cost_amount, marketplace)
select 2401,
       (select id from app.staff where code = 'EE'),
       (select id from app.staff where code = 'HH'),
       date '2026-09-18', 'BDZ-ZW1700', 16140, 'ヤフオク';

select sku, lot_seq, is_accessory, status, identity_check from app.items order by sku;

\echo '--- [2] 納品担当者 (久保田/DD) から見える作業一覧 ---'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select sku, title, status, arrived_on from app.v_delivery_tasks order by sku;

\echo '--- [3] 自分の担当分は作業チェックできる ---'
select sku, status, arrived_on, product_registered_at is not null as registered
from app.set_work_progress(
  (select id from app.items where title = 'DMR-BRZ1020'), 'arrived', true);
select sku, status from app.set_work_progress(
  (select id from app.items where title = 'DMR-BRZ1020'), 'registered', true);

\echo '--- [4] 他人の担当分は更新できない（エラーになるのが正しい） ---'
-- 管理者として他人の商品の id を控えてから、納品担当者に戻って試す
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
create temp table other_item as select id from app.items where title = 'BDZ-ZW1700';
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare v_id uuid;
begin
  select id into v_id from other_item;
  begin
    perform app.set_work_progress(v_id, 'arrived', true);
    raise exception 'FAIL: 他人の商品を更新できてしまった';
  exception
    when insufficient_privilege then raise notice 'OK: 担当外は 42501 でブロックされた';
    when no_data_found then raise notice 'OK: 担当外は参照できずブロックされた';
  end;
end $$;

\echo '--- [5] 納品担当者は items を直接 UPDATE できない ---'
do $$
declare n int;
begin
  update app.items set cost_amount = 1 where title = 'DMR-BRZ1020';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FAIL: 直接更新が通った'; end if;
  raise notice 'OK: 直接 UPDATE は 0 行（RLS でブロック）';
end $$;

\echo '--- [6] 販売登録と古物台帳 ---'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update app.items
   set sold_on = date '2026-10-02', sold_price = 21980, payout_amount = 18683, shipping_cost = 0
 where title = 'DMR-BRZ1020';

select sku, status, profit, days_to_sell from app.v_items where title = 'DMR-BRZ1020';
select 取引区分, 取引年月日, 品目, 代価, 相手方, 確認方法 from app.v_antique_ledger order by 取引年月日, 取引区分;

\echo '--- [7] 集計ビュー ---'
select * from app.v_stock_summary;
select month, 仕入数, 仕入金額, 販売数, 売上, 粗利益, 純利益 from app.v_monthly_summary;
select deliverer_name, 未完了, 作業中 from app.v_deliverer_workload;

\echo '--- [8] SKU の往復変換 ---'
select * from app.parse_sku('2400-AADD-20260916-1296');

\echo '--- [9] 仕入れを伴わない行（担当者が納品側だけ / SKU 中央ブロックが2文字） ---'
insert into app.items (sku, lot_seq, deliverer_id, purchased_at, title, cost_amount,
                       marketplace, status, is_accessory)
select '2402a-DD-20260920-0', 2402,
       (select id from app.staff where code = 'DD'),
       date '2026-09-20', 'Amazon返品の再処理', 0, 'Amazon返品', 'Amazon返品', false;

select sku, status, purchaser_id is null as 仕入担当者なし from app.items where sku like '2402a%';

-- 再作業が始まったら通常の進捗に合流する
select sku, status from app.set_work_progress(
  (select id from app.items where sku = '2402a-DD-20260920-0'), 'arrived', true);

do $$
begin
  if (select status from app.items where sku = '2402a-DD-20260920-0') <> '入荷済' then
    raise exception 'FAIL: Amazon返品 が再作業開始後も合流していない';
  end if;
  raise notice 'OK: Amazon返品 → 入荷済 に合流した';
end $$;

\echo '--- [10] 古物台帳の不備が洗い出される ---'
insert into app.items (sku, lot_seq, purchaser_id, deliverer_id, purchased_at, title,
                       cost_amount, marketplace)
select '2403-AADD-20260901-5000', 2403,
       (select id from app.staff where code = 'AA'),
       (select id from app.staff where code = 'DD'),
       date '2026-09-01', '相手方未記入の高額仕入れ', 50000, 'ヤフオク';

select sku, 不備 from app.v_ledger_gaps order by sku;

\echo '--- [11] 監査ログが残っている ---'
select table_name, action, count(*) from app.audit_log group by 1,2 order by 2;
reset role;
