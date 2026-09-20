-- =============================================================================
-- 物販管理システム / コアスキーマ
--
-- 現行のスプレッドシート（総合管理表・納品管理表）を Supabase に移行するための
-- テーブル定義。SKU を唯一の連携キーとし、
--   - 大元アプリ（admin）   : 全データの読み書き
--   - 納品担当アプリ(delivery): 自分が担当する SKU の作業進捗のみ
-- という 2 アプリ構成を前提にしている。
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

create schema if not exists app;

-- -----------------------------------------------------------------------------
-- ENUM 定義（スプレッドシートの入力値をそのまま踏襲）
-- -----------------------------------------------------------------------------
create type app.staff_role as enum ('admin', 'purchaser', 'deliverer');

-- 実データ（納品管理表 全シート）に現れた仕入れ先をすべて網羅する
create type app.marketplace as enum (
  'メルカリ', 'ヤフオク', 'ヤフフリ', 'PayPayフリマ', 'ラクマ', 'ジモティー',
  'オフモール', '2ndストリート', 'トレジャーファクトリー', '楽天', '店舗',
  'Amazon返品',   -- Amazon から返品されてきた個体を再度登録したもの
  'その他'
);

create type app.sales_channel as enum (
  'FBA', '自己発送', 'メルカリ', 'ヤフオク', 'ヤフフリ', 'その他'
);

-- Amazon のコンディションに合わせる（納品管理表「状態」列のうち品質を表す値）
create type app.item_condition as enum (
  '新品', '再生品', 'ほぼ新品', '非常に良い', '良い', '可', 'ジャンク'
);

-- 納品管理表では「状態」列に品質と進行状態が混在していたため分離する。
-- 「返品処理」と「Amazo返品」は向きが逆の別物なので、別の値として残す。
create type app.item_status as enum (
  '仕入済',       -- 購入直後（未入荷）
  '入荷済',       -- 納品担当者の手元に到着
  '作業中',       -- 商品登録・検品・撮影のいずれかが進行中
  '出荷済',       -- FBA へ納品 / 自己発送で保管中
  '出品中',
  '販売済',
  '返品処理',     -- 仕入先へ返品した（こちらから返す）
  'Amazon返品',   -- Amazon から返品されてきた（再検品・再出品の対象）
  '保留',
  '廃棄'
);

create type app.turnover_class as enum ('高', '中', '低');

-- 納品管理表では担当者名に (テ)(ブ)(付) の接頭辞が付いていた。
-- これは人ではなく「どの作業ラインの仕事か」を表していたため、列として切り出す。
create type app.work_stream as enum ('テレビ', 'ブルーレイ', '付属品', 'その他');

create type app.expense_category as enum ('固定費', '変動費', '給与', '外注費', '諸経費');

-- 古物台帳の取引区分
create type app.ledger_kind as enum ('買受', '売却');

-- 古物営業法 15 条の本人確認方法
create type app.identity_check_method as enum (
  '非対面(取引記録)',   -- ネット仕入れ。プラットフォームの取引記録で確認
  '本人確認書類',
  '電子署名',
  'その他',
  '確認不要(1万円未満)'
);

-- -----------------------------------------------------------------------------
-- スタッフ / 認証
-- -----------------------------------------------------------------------------
create table app.staff (
  id            uuid primary key default gen_random_uuid(),
  -- SKU の中央ブロックに使う 2 文字コード（例: 長部一輝 = AA, 石川秀樹 = EE）
  code          char(2) not null unique check (code ~ '^[A-Z]{2}$'),
  name          text    not null,
  display_name  text,
  role          app.staff_role not null default 'deliverer',
  is_company    boolean not null default false,  -- 外注先（株式会社コエル等）
  email         text unique,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column app.staff.code is 'SKU 中央ブロック用の 2 文字コード。仕入担当者コード + 納品担当者コードで 4 文字になる。';

-- Supabase Auth のユーザーと app.staff を紐付ける
create table app.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  staff_id    uuid not null references app.staff(id) on delete restrict,
  created_at  timestamptz not null default now()
);

create unique index profiles_staff_id_key on app.profiles(staff_id);

-- -----------------------------------------------------------------------------
-- クレジットカード（総合管理表「クレカ管理」）
-- -----------------------------------------------------------------------------
create table app.payment_cards (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,            -- 三井住友 / 楽天 / メルカード / PayPay / セゾン / アメックス
  last4         char(4),
  credit_limit  bigint check (credit_limit >= 0),
  closing_day   text,                            -- '末' や '15' など表記ゆれを許容
  payment_day   smallint check (payment_day between 1 and 31),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 商品マスタ（総合管理表「商品リスト」＝リサーチ台帳）
-- -----------------------------------------------------------------------------
create table app.products (
  id                    uuid primary key default gen_random_uuid(),
  product_no            integer unique,          -- 商品リストの「商品番号」＝納品管理表の「品番」
  asin                  char(10) not null unique check (asin ~ '^[A-Z0-9]{10}$'),
  model_no              text,                    -- 型番
  maker                 text,
  genre                 text,
  -- 「非常に良い販売」＝Amazon での想定販売価格
  list_price            bigint check (list_price >= 0),
  -- 「振込額」＝手数料控除後にAmazonから入金される見込み額
  payout_estimate       bigint check (payout_estimate >= 0),
  -- 「仕入れ目標」＝この金額以下で仕入れる
  target_cost           bigint check (target_cost >= 0),
  turnover              app.turnover_class,
  has_sold_before       boolean not null default false,   -- 売ったことがあるか
  monthly_purchase_cap  integer,                          -- 月間メルカリ仕入れ可個数
  expected_sales_qty    integer,                          -- 見込み販売個数
  image_url             text,
  keepa_url             text,
  amazon_url            text generated always as
                          ('https://www.amazon.co.jp/dp/' || asin) stored,
  release_date          date,
  memo                  text,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index products_model_no_trgm on app.products using gin (model_no gin_trgm_ops);
create index products_maker_idx on app.products(maker);
create index products_turnover_idx on app.products(turnover);

-- -----------------------------------------------------------------------------
-- ロット（通番号）
--   1 つの商品本体と、後から買い足したリモコン等の付属品が同じ通番号を共有する。
--   例: 通番号 2340 = 本体 2340-EEMM-20260916-1296 + リモコン 2340-AAMM-20260924-173
-- -----------------------------------------------------------------------------
create table app.lots (
  seq         integer primary key,               -- 通番号
  opened_at   date not null default current_date,
  note        text,
  created_at  timestamptz not null default now()
);

create sequence app.lot_seq_counter as integer start 1;

-- -----------------------------------------------------------------------------
-- 仕入明細（= 在庫 1 点 = 古物台帳の 1 行）
-- -----------------------------------------------------------------------------
create table app.items (
  id                uuid primary key default gen_random_uuid(),

  -- ▼ 連携キー。2 つのアプリはこの SKU だけで会話する
  -- 中央ブロックは通常 4 文字（仕入担当+納品担当）だが、
  -- 仕入れを伴わない行（付属品の単独手配・Amazon返品の再処理）は
  -- 納品担当者の 2 文字だけになる。通番号には a / aa の再処理接尾辞が付くことがある。
  sku               text not null unique
                      check (sku ~ '^[0-9]+[a-z]*-[A-Z]{2,4}-[0-9]{8}-[0-9]+$'),

  lot_seq           integer not null references app.lots(seq) on delete restrict,
  is_accessory      boolean not null default false,   -- リモコン等の買い足し

  -- ▼ 担当者
  -- 仕入担当者は、仕入れを伴わない行（Amazon返品の再登録など）では空になる
  purchaser_id      uuid references app.staff(id) on delete restrict,
  deliverer_id      uuid references app.staff(id) on delete restrict,
  work_stream       app.work_stream,

  -- ▼ 仕入情報（古物台帳「買受」の原本）
  -- 移行元に購入日が入っていない行があるため NULL を許すが、
  -- 古物台帳としては不備なので app.v_ledger_gaps で洗い出せるようにしてある
  purchased_at      date,
  title             text   not null,             -- 商品名（型番であることが多い）
  cost_amount       bigint not null check (cost_amount >= 0),
  marketplace       app.marketplace not null,
  marketplace_item_id text,                      -- メルカリ m123... / ヤフオク q123...
  marketplace_url   text,
  card_id           uuid references app.payment_cards(id) on delete set null,
  tracking_no       text,

  -- ▼ 商品情報
  product_id        uuid references app.products(id) on delete set null,
  asin              char(10),
  condition         app.item_condition,
  accessories       text,                        -- 付属品
  description       text,                        -- Amazon 出品用の説明文

  -- ▼ 販売計画
  planned_price     bigint check (planned_price >= 0),
  planned_payout    bigint check (planned_payout >= 0),
  sales_channel     app.sales_channel,

  -- ▼ 進行状態
  status            app.item_status not null default '仕入済',
  arrived_on        date,

  -- ▼ 納品担当者の作業チェック（納品管理表の TRUE/FALSE 列）
  product_registered_at timestamptz,             -- 商品登録・撮影
  inspected_at          timestamptz,             -- 検品・清掃
  photo_uploaded_at     timestamptz,             -- 写真登録
  packed_on             date,                    -- 梱包日
  shipped_on            date,                    -- 出荷日

  -- ▼ 出品・販売
  listed_on         date,
  sold_on           date,
  sold_price        bigint check (sold_price >= 0),
  payout_amount     bigint check (payout_amount >= 0),   -- 実際の振込額
  shipping_cost     bigint not null default 0 check (shipping_cost >= 0),
  other_cost        bigint not null default 0 check (other_cost >= 0),

  -- 粗利（振込額 - 仕入 - 送料 - その他）
  profit            bigint generated always as (
                      coalesce(payout_amount, 0) - cost_amount - shipping_cost - other_cost
                    ) stored,

  -- ▼ 古物台帳（相手方の確認）
  seller_name       text,
  seller_address    text,
  seller_occupation text,
  seller_age        smallint check (seller_age between 0 and 150),
  identity_check    app.identity_check_method,
  identity_checked_on date,

  returned_on       date,
  return_reason     text,

  memo              text,
  created_by        uuid references app.staff(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- 販売済みなら販売日と金額が必須
  constraint items_sold_requires_date
    check (status <> '販売済' or (sold_on is not null and sold_price is not null))
);

comment on table app.items is '仕入れた個体 1 点ごとのレコード。古物台帳の買受行そのものでもある。';
comment on column app.items.sku is '出品者SKU。{通番号}-{仕入担当コード}{納品担当コード}-{購入日YYYYMMDD}-{仕入金額÷10}。一度採番したら変更しない。';

create index items_deliverer_idx  on app.items(deliverer_id, status);
create index items_purchaser_idx  on app.items(purchaser_id, purchased_at desc);
create index items_status_idx     on app.items(status);
create index items_purchased_idx  on app.items(purchased_at desc);
create index items_sold_idx       on app.items(sold_on desc) where sold_on is not null;
create index items_lot_idx        on app.items(lot_seq);
create index items_product_idx    on app.items(product_id);
create index items_asin_idx       on app.items(asin);
create index items_title_trgm     on app.items using gin (title gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 商品写真（納品担当アプリからアップロード → Storage の path を保持）
-- -----------------------------------------------------------------------------
create table app.item_photos (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references app.items(id) on delete cascade,
  storage_path text not null,
  sort_order  smallint not null default 0,
  is_main     boolean not null default false,
  uploaded_by uuid references app.staff(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index item_photos_item_idx on app.item_photos(item_id, sort_order);
create unique index item_photos_one_main on app.item_photos(item_id) where is_main;

-- -----------------------------------------------------------------------------
-- コメント（納品管理表の「仕入担当者→納品担当者コメント」/ 逆方向を会話形式に）
-- -----------------------------------------------------------------------------
create table app.item_comments (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references app.items(id) on delete cascade,
  author_id   uuid not null references app.staff(id) on delete restrict,
  body        text not null check (length(btrim(body)) > 0),
  created_at  timestamptz not null default now()
);

create index item_comments_item_idx on app.item_comments(item_id, created_at);

-- -----------------------------------------------------------------------------
-- 経費（総合管理表「経費」シート）
-- -----------------------------------------------------------------------------
create table app.expenses (
  id          uuid primary key default gen_random_uuid(),
  incurred_on date not null,
  category    app.expense_category not null,
  name        text not null,
  amount      bigint not null check (amount >= 0),
  card_id     uuid references app.payment_cards(id) on delete set null,
  staff_id    uuid references app.staff(id) on delete set null,  -- 給与・外注費の支払先
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index expenses_period_idx on app.expenses(incurred_on desc, category);

-- -----------------------------------------------------------------------------
-- 監査ログ（古物台帳は訂正履歴が残せる必要がある）
-- -----------------------------------------------------------------------------
create table app.audit_log (
  id          bigserial primary key,
  table_name  text not null,
  row_id      uuid not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changed_by  uuid references app.staff(id) on delete set null,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_row_idx on app.audit_log(table_name, row_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 取り込み時の衝突（同じ SKU が複数行に存在した等）
--   スプレッドシート側の不整合を黙って捨てないための退避先。
--   大元アプリで内容を確認して、正しい SKU を振り直してから items に移す。
-- -----------------------------------------------------------------------------
create table app.import_conflicts (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null,
  reason      text not null,
  source      text,               -- 元のシート名
  payload     jsonb not null,     -- 取り込もうとした行の内容
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index import_conflicts_sku_idx on app.import_conflicts(sku);
