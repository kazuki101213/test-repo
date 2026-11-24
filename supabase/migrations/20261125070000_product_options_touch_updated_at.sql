-- 2026-11-25 商品の通り（付属品・状態違い）も、変更したら updated_at を更新する。
-- 自作フリマウォッチなどが「商品リストが変わった時だけ全件を読み直す」判定に使う。
drop trigger if exists product_options_touch_updated_at on app.product_options;
create trigger product_options_touch_updated_at
  before update on app.product_options
  for each row execute function app.touch_updated_at();
