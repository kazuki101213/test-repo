-- 2026-11-24: 商品ごとの利益率（振込想定金額に対する%）。入っていれば仕入れ目標金額＝振込想定×(100－利益率)%、
-- 空欄なら決まりの割合（1万円以下23%・5万円以下20%・5万円超17%）。
alter table app.products
  add column if not exists target_profit_rate smallint
  check (target_profit_rate between 0 and 99);

comment on column app.products.target_profit_rate is
  '利益率（%）。空欄なら決まりの割合（1万円以下23%・5万円以下20%・5万円超17%）で仕入れ目標金額を出す。';
