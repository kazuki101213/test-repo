-- =============================================================================
-- ビュー
--   security_invoker = on にして、ビュー越しでも RLS が効くようにする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 在庫一覧（大元アプリのメイン画面）
-- -----------------------------------------------------------------------------
drop view if exists app.v_items cascade;
create view app.v_items with (security_invoker = on) as
select
  i.id,
  i.sku,
  i.lot_seq,
  i.is_accessory,
  i.status,
  i.condition,
  i.title,
  i.asin,
  p.model_no,
  p.maker,
  p.genre,
  p.turnover,
  i.purchased_at,
  i.cost_amount,
  i.marketplace,
  i.marketplace_url,
  c.name              as card_name,
  buyer.name          as purchaser_name,
  deliv.name          as deliverer_name,
  i.work_stream,
  i.deliverer_id,
  i.purchaser_id,
  i.tracking_no,
  i.planned_price,
  i.planned_payout,
  i.sales_channel,
  i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null)          as inspected,
  (i.photo_uploaded_at is not null)     as photo_uploaded,
  i.packed_on,
  i.shipped_on,
  i.listed_on,
  i.sold_on,
  i.sold_price,
  i.payout_amount,
  i.amazon_returned_on,
  i.refund_amount,
  i.profit,
  -- 仕入から販売までの日数（回転日数）
  (i.sold_on - i.purchased_at)          as days_to_sell,
  -- 未販売なら仕入からの経過日数
  case when i.sold_on is null then current_date - i.purchased_at end as days_in_stock,
  case
    when i.planned_payout is not null
      then i.planned_payout - i.cost_amount
  end                                   as expected_profit,
  i.accessories,
  i.memo,
  i.updated_at
from app.items i
left join app.products p     on p.id = i.product_id
left join app.payment_cards c on c.id = i.card_id
left join app.staff buyer    on buyer.id = i.purchaser_id
left join app.staff deliv    on deliv.id = i.deliverer_id;

-- -----------------------------------------------------------------------------
-- 納品担当アプリの作業一覧
--   RLS により自分の担当行しか見えない。
-- -----------------------------------------------------------------------------
drop view if exists app.v_delivery_tasks cascade;
create view app.v_delivery_tasks with (security_invoker = on) as
select
  i.id,
  i.sku,
  i.lot_seq,
  i.is_accessory,
  i.status,
  i.work_stream,
  i.title,
  i.asin,
  i.condition,
  i.purchased_at,
  i.marketplace,
  i.tracking_no,
  i.accessories,
  i.description,
  i.sales_channel,
  i.planned_price,
  i.deliverer_id,
  buyer.name as purchaser_name,
  i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null)          as inspected,
  (i.photo_uploaded_at is not null)     as photo_uploaded,
  i.packed_on,
  i.shipped_on,
  i.amazon_returned_on,
  p.image_url                           as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id = i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id = i.id) as last_comment_at
from app.items i
left join app.products p  on p.id = i.product_id
left join app.staff buyer on buyer.id = i.purchaser_id
-- Amazon返品 は再検品・再出品が必要なので、納品担当者の作業一覧に出す
where i.status in ('仕入済', '入荷済', '作業中', 'Amazon返品');

-- -----------------------------------------------------------------------------
-- 古物台帳
--   古物営業法施行規則 第16条 の記載事項に対応させる。
--   買受（仕入れ）と売却（販売）の両方を 1 本のビューに並べる。
-- -----------------------------------------------------------------------------
drop view if exists app.v_antique_ledger cascade;
create view app.v_antique_ledger with (security_invoker = on) as
-- 買受
select
  i.sku,
  '買受'::app.ledger_kind          as 取引区分,
  i.purchased_at                    as 取引年月日,
  coalesce(p.genre, '家電・事務機器類') as 品目,
  i.title
    || coalesce(' / 型番:' || p.model_no, '')
    || coalesce(' / ASIN:' || i.asin, '')
    || coalesce(' / 状態:' || i.condition::text, '') as 特徴,
  1                                 as 数量,
  i.cost_amount                     as 代価,
  coalesce(i.seller_name, i.marketplace::text || ' 出品者(' || coalesce(i.marketplace_item_id, '-') || ')') as 相手方,
  i.seller_address                  as 相手方住所,
  i.seller_occupation               as 相手方職業,
  i.seller_age                      as 相手方年齢,
  i.identity_check                  as 確認方法,
  i.marketplace_url                 as 取引記録リンク,
  i.created_at
from app.items i
left join app.products p on p.id = i.product_id

union all

-- 売却
select
  i.sku,
  '売却'::app.ledger_kind,
  i.sold_on,
  coalesce(p.genre, '家電・事務機器類'),
  i.title
    || coalesce(' / 型番:' || p.model_no, '')
    || coalesce(' / ASIN:' || i.asin, ''),
  1,
  i.sold_price,
  coalesce(i.sales_channel::text, '-') || ' 購入者',
  null, null, null,
  null::app.identity_check_method,
  null,
  i.updated_at
from app.items i
left join app.products p on p.id = i.product_id
where i.sold_on is not null;

comment on view app.v_antique_ledger is
  '古物台帳。ネット仕入れは非対面取引のため、相手方の確認はプラットフォームの取引記録（marketplace_url / marketplace_item_id）で代替している。1万円以上の取引は seller_* 列の記入が必要。';

-- -----------------------------------------------------------------------------
-- 月次サマリ（総合管理表のダッシュボード相当）
-- -----------------------------------------------------------------------------
drop view if exists app.v_monthly_summary cascade;
create view app.v_monthly_summary with (security_invoker = on) as
with purchased as (
  select date_trunc('month', purchased_at)::date as month,
         count(*) as 仕入数, sum(cost_amount) as 仕入金額,
         avg(cost_amount)::bigint as 平均仕入額
  from app.items group by 1
),
sold as (
  select date_trunc('month', sold_on)::date as month,
         count(*) as 販売数, sum(sold_price) as 売上,
         sum(payout_amount) as 振込金額, sum(profit) as 粗利益,
         avg(sold_price)::bigint as 平均販売額,
         avg(sold_on - purchased_at)::numeric(10,1) as 平均回転日数
  from app.items where sold_on is not null group by 1
),
expense as (
  select date_trunc('month', incurred_on)::date as month, sum(amount) as 経費
  from app.expenses group by 1
)
select
  coalesce(p.month, s.month, e.month) as month,
  coalesce(p.仕入数, 0)      as 仕入数,
  coalesce(p.仕入金額, 0)    as 仕入金額,
  coalesce(p.平均仕入額, 0)  as 平均仕入額,
  coalesce(s.販売数, 0)      as 販売数,
  coalesce(s.売上, 0)        as 売上,
  coalesce(s.振込金額, 0)    as 振込金額,
  coalesce(s.粗利益, 0)      as 粗利益,
  coalesce(s.平均販売額, 0)  as 平均販売額,
  s.平均回転日数,
  coalesce(e.経費, 0)        as 経費,
  coalesce(s.粗利益, 0) - coalesce(e.経費, 0) as 純利益
from purchased p
full join sold s   on s.month = p.month
full join expense e on e.month = coalesce(p.month, s.month)
order by 1 desc;

-- -----------------------------------------------------------------------------
-- 在庫サマリ（現在庫の評価額）
-- -----------------------------------------------------------------------------
drop view if exists app.v_stock_summary cascade;
create view app.v_stock_summary with (security_invoker = on) as
select
  count(*)                                        as 現在庫数,
  sum(cost_amount)                                as 仕入金額合計,
  sum(coalesce(planned_payout, 0))                as 売上見込み合計,
  sum(coalesce(planned_payout, 0) - cost_amount)  as 見込み利益合計,
  count(*) filter (where current_date - purchased_at <= 7)                        as 高回転,
  count(*) filter (where current_date - purchased_at between 8 and 14)            as 中回転,
  count(*) filter (where current_date - purchased_at >= 15)                       as 低回転,
  count(*) filter (where status = '作業中')                                        as 作業中,
  count(*) filter (where status = '仕入済')                                        as 入荷待ち
from app.items
where status not in ('販売済', '返品処理', '廃棄');

-- -----------------------------------------------------------------------------
-- 担当者別の稼働（納品管理表のピボット相当）
-- -----------------------------------------------------------------------------
drop view if exists app.v_deliverer_workload cascade;
create view app.v_deliverer_workload with (security_invoker = on) as
select
  s.id   as deliverer_id,
  s.name as deliverer_name,
  count(*) filter (where i.status in ('仕入済', '入荷済', '作業中', 'Amazon返品')) as 未完了,
  count(*) filter (where i.status = '作業中')                          as 作業中,
  count(*) filter (where i.shipped_on >= date_trunc('month', current_date)) as 今月出荷,
  count(*) filter (where i.arrived_on is not null and i.shipped_on is null) as 手元在庫,
  avg(i.shipped_on - i.arrived_on) filter (where i.shipped_on is not null)::numeric(10,1) as 平均作業日数
from app.staff s
join app.items i on i.deliverer_id = s.id
where s.is_active
group by s.id, s.name
order by 未完了 desc;

-- -----------------------------------------------------------------------------
-- 商品マスタ別の実績（どの ASIN が儲かっているか）
-- -----------------------------------------------------------------------------
drop view if exists app.v_product_performance cascade;
create view app.v_product_performance with (security_invoker = on) as
select
  p.id as product_id,
  p.product_no,
  p.asin,
  p.model_no,
  p.maker,
  p.turnover,
  p.target_cost,
  p.list_price,
  count(i.id)                                                as 仕入実績数,
  count(i.id) filter (where i.sold_on is not null)           as 販売実績数,
  count(i.id) filter (where i.status not in ('販売済','返品処理','廃棄')) as 在庫数,
  avg(i.cost_amount)::bigint                                 as 平均仕入額,
  avg(i.sold_price) filter (where i.sold_on is not null)::bigint as 平均販売額,
  sum(i.profit) filter (where i.sold_on is not null)         as 累計粗利,
  avg(i.sold_on - i.purchased_at) filter (where i.sold_on is not null)::numeric(10,1) as 平均回転日数
from app.products p
left join app.items i on i.product_id = p.id
group by p.id;

-- -----------------------------------------------------------------------------
-- 古物台帳としての不備を洗い出す
--   スプレッドシートから移した行には、購入日や相手方が欠けているものがある。
--   黙って埋めると帳簿として嘘になるので、欠けたまま一覧できるようにする。
-- -----------------------------------------------------------------------------
drop view if exists app.v_ledger_gaps cascade;
create view app.v_ledger_gaps with (security_invoker = on) as
select
  i.sku,
  i.title,
  i.purchased_at,
  i.cost_amount,
  i.marketplace,
  i.status,
  case
    when i.purchased_at is null                                then '取引年月日が未記入'
    when i.cost_amount >= 10000 and i.seller_address is null   then '1万円以上だが相手方の住所が未記入'
    when i.cost_amount >= 10000 and i.seller_name is null      then '1万円以上だが相手方の氏名が未記入'
    when i.marketplace_item_id is null and i.marketplace_url is null
                                                               then '取引記録（取引ID・URL）がない'
  end as 不備,
  i.id
from app.items i
where i.purchased_at is null
   or (i.cost_amount >= 10000 and (i.seller_address is null or i.seller_name is null))
   or (i.marketplace_item_id is null and i.marketplace_url is null);

grant select on app.v_ledger_gaps to authenticated;

-- -----------------------------------------------------------------------------
-- 権限の付け直し
--   ビューを作り直すと、それまでの GRANT は一緒に消える。
--   このファイルだけを流し直したときに権限が落ちないよう、
--   最後に app スキーマのビュー全部へまとめて付け直す。
--   （後からビューを足しても自動で対象になる）
-- -----------------------------------------------------------------------------
do $$
declare
  v record;
begin
  for v in
    select table_name from information_schema.views where table_schema = 'app'
  loop
    execute format('grant select on app.%I to authenticated', v.table_name);
  end loop;
end
$$;
