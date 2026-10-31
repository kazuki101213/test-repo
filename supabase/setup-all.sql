-- =============================================================================
-- 物販管理システム — セットアップ用 SQL（自動生成）
--
--   このファイルは supabase/migrations/*.sql を連結したものです。
--   直接編集しないでください。migrations 側を直して
--   scripts/build-sql-bundle.sh を実行し直してください。
--
-- 使い方
--   1. Supabase のダッシュボードで左メニューの「SQL Editor」を開く
--   2. このファイルの中身を全部コピーして貼り付ける
--   3. 右下の「Run」を押す
--
--   何度流しても壊れないようには作っていません。エラーが出た場合は
--   一度 `drop schema app cascade;` で消してから流し直してください。
-- =============================================================================

-- ▼▼▼ 20260920000100_core_schema.sql ▼▼▼

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
-- ENUM を安全に作る / 足りない値を足す
--   途中でエラーになった実行をやり直せるように、この SQL は何度流しても通る。
--   型が既にあっても、値が足りなければ追加する（古い状態で止まっていても直る）。
-- -----------------------------------------------------------------------------
create or replace function app.ensure_enum(p_name text, p_labels text[])
returns void
language plpgsql
as $ensure$
declare
  v_label text;
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typname = p_name and n.nspname = 'app'
  ) then
    execute format(
      'create type app.%I as enum (%s)',
      p_name,
      (select string_agg(quote_literal(l), ', ') from unnest(p_labels) as l)
    );
    return;
  end if;

  foreach v_label in array p_labels loop
    if not exists (
      select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
      where t.typname = p_name and n.nspname = 'app' and e.enumlabel = v_label
    ) then
      execute format('alter type app.%I add value %L', p_name, v_label);
    end if;
  end loop;
end;
$ensure$;


-- -----------------------------------------------------------------------------
-- ENUM 定義（スプレッドシートの入力値をそのまま踏襲）
-- -----------------------------------------------------------------------------
select app.ensure_enum('staff_role', array['admin', 'purchaser', 'deliverer']);

-- 実データ（納品管理表 全シート）に現れた仕入れ先をすべて網羅する
select app.ensure_enum('marketplace', array['メルカリ', 'ヤフオク', 'ヤフフリ', 'PayPayフリマ', 'ラクマ', 'ジモティー', 'オフモール', '2ndストリート', 'トレジャーファクトリー', '楽天', '店舗', 'Amazon返品', 'その他']);

select app.ensure_enum('sales_channel', array['FBA', '自己発送', 'メルカリ', 'ヤフオク', 'ヤフフリ', 'その他']);

-- Amazon のコンディションに合わせる（納品管理表「状態」列のうち品質を表す値）
select app.ensure_enum('item_condition', array['新品', '再生品', 'ほぼ新品', '非常に良い', '良い', '可', 'ジャンク']);

-- 納品管理表では「状態」列に品質と進行状態が混在していたため分離する。
-- 「返品処理」と「Amazo返品」は向きが逆の別物なので、別の値として残す。
select app.ensure_enum('item_status', array['仕入済', '入荷済', '作業中', '出荷済', '出品中', '販売済', '返品処理', 'Amazon返品', '保留', '廃棄']);

select app.ensure_enum('turnover_class', array['高', '中', '低']);

-- 納品管理表では担当者名に (テ)(ブ)(付) の接頭辞が付いていた。
-- これは人ではなく「どの作業ラインの仕事か」を表していたため、列として切り出す。
select app.ensure_enum('work_stream', array['テレビ', 'ブルーレイ', '付属品', 'その他']);

select app.ensure_enum('expense_category', array['固定費', '変動費', '給与', '外注費', '諸経費']);

-- 古物台帳の取引区分
select app.ensure_enum('ledger_kind', array['買受', '売却']);

-- 古物営業法 15 条の本人確認方法
select app.ensure_enum('identity_check_method', array['非対面(取引記録)', '本人確認書類', '電子署名', 'その他', '確認不要(1万円未満)']);

-- -----------------------------------------------------------------------------
-- スタッフ / 認証
-- -----------------------------------------------------------------------------
create table if not exists app.staff (
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
create table if not exists app.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  staff_id    uuid not null references app.staff(id) on delete restrict,
  created_at  timestamptz not null default now()
);

create unique index if not exists profiles_staff_id_key on app.profiles(staff_id);

-- -----------------------------------------------------------------------------
-- クレジットカード（総合管理表「クレカ管理」）
-- -----------------------------------------------------------------------------
create table if not exists app.payment_cards (
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
create table if not exists app.products (
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

create index if not exists products_model_no_trgm on app.products using gin (model_no gin_trgm_ops);
create index if not exists products_maker_idx on app.products(maker);
create index if not exists products_turnover_idx on app.products(turnover);

-- -----------------------------------------------------------------------------
-- ロット（通番号）
--   1 つの商品本体と、後から買い足したリモコン等の付属品が同じ通番号を共有する。
--   例: 通番号 2340 = 本体 2340-EEMM-20260916-1296 + リモコン 2340-AAMM-20260924-173
-- -----------------------------------------------------------------------------
create table if not exists app.lots (
  seq         integer primary key,               -- 通番号
  opened_at   date not null default current_date,
  note        text,
  created_at  timestamptz not null default now()
);

create sequence if not exists app.lot_seq_counter as integer start 1;

-- -----------------------------------------------------------------------------
-- 仕入明細（= 在庫 1 点 = 古物台帳の 1 行）
-- -----------------------------------------------------------------------------
create table if not exists app.items (
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

  -- 受け取った返金（仕入れ先関連返金 / Amazon一部返金 / Amazon在庫払い戻し）。
  -- 利益を押し上げる側の金額なので、原価ではなく収入として足す。
  refund_amount     bigint not null default 0 check (refund_amount >= 0),
  refund_note       text,

  -- 粗利（振込額 + 返金 - 仕入 - 送料 - その他）
  profit            bigint generated always as (
                      coalesce(payout_amount, 0) + refund_amount
                      - cost_amount - shipping_cost - other_cost
                    ) stored,

  -- ▼ 古物台帳（相手方の確認）
  seller_name       text,
  seller_address    text,
  seller_occupation text,
  seller_age        smallint check (seller_age between 0 and 150),
  identity_check    app.identity_check_method,
  identity_checked_on date,

  returned_on       date,        -- 仕入先へ返品した日
  return_reason     text,

  -- Amazon から返品されてきた日。作業が一通り終わった個体が戻ってくるので、
  -- 作業チェックを消さずに「再作業が必要」だけを別の事実として持たせる。
  amazon_returned_on date,

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

create index if not exists items_deliverer_idx  on app.items(deliverer_id, status);
create index if not exists items_purchaser_idx  on app.items(purchaser_id, purchased_at desc);
create index if not exists items_status_idx     on app.items(status);
create index if not exists items_purchased_idx  on app.items(purchased_at desc);
create index if not exists items_sold_idx       on app.items(sold_on desc) where sold_on is not null;
create index if not exists items_lot_idx        on app.items(lot_seq);
create index if not exists items_product_idx    on app.items(product_id);
create index if not exists items_asin_idx       on app.items(asin);
create index if not exists items_title_trgm     on app.items using gin (title gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 商品写真（納品担当アプリからアップロード → Storage の path を保持）
-- -----------------------------------------------------------------------------
create table if not exists app.item_photos (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references app.items(id) on delete cascade,
  storage_path text not null,
  sort_order  smallint not null default 0,
  is_main     boolean not null default false,
  uploaded_by uuid references app.staff(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists item_photos_item_idx on app.item_photos(item_id, sort_order);
create unique index if not exists item_photos_one_main on app.item_photos(item_id) where is_main;

-- -----------------------------------------------------------------------------
-- コメント（納品管理表の「仕入担当者→納品担当者コメント」/ 逆方向を会話形式に）
-- -----------------------------------------------------------------------------
create table if not exists app.item_comments (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references app.items(id) on delete cascade,
  author_id   uuid not null references app.staff(id) on delete restrict,
  body        text not null check (length(btrim(body)) > 0),
  created_at  timestamptz not null default now()
);

create index if not exists item_comments_item_idx on app.item_comments(item_id, created_at);

-- -----------------------------------------------------------------------------
-- 経費（総合管理表「経費」シート）
-- -----------------------------------------------------------------------------
create table if not exists app.expenses (
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

create index if not exists expenses_period_idx on app.expenses(incurred_on desc, category);

-- -----------------------------------------------------------------------------
-- 監査ログ（古物台帳は訂正履歴が残せる必要がある）
-- -----------------------------------------------------------------------------
create table if not exists app.audit_log (
  id          bigserial primary key,
  table_name  text not null,
  row_id      uuid not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changed_by  uuid references app.staff(id) on delete set null,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_row_idx on app.audit_log(table_name, row_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 取り込み時の衝突（同じ SKU が複数行に存在した等）
--   スプレッドシート側の不整合を黙って捨てないための退避先。
--   大元アプリで内容を確認して、正しい SKU を振り直してから items に移す。
-- -----------------------------------------------------------------------------
create table if not exists app.import_conflicts (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null,
  reason      text not null,
  source      text,               -- 元のシート名
  payload     jsonb not null,     -- 取り込もうとした行の内容
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists import_conflicts_sku_idx on app.import_conflicts(sku);


-- ▼▼▼ 20260920000200_functions.sql ▼▼▼

-- =============================================================================
-- 関数・トリガー
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 認証ヘルパー
-- -----------------------------------------------------------------------------
create or replace function app.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = app, public
as $$
  select p.staff_id from app.profiles p where p.user_id = auth.uid();
$$;

create or replace function app.current_role()
returns app.staff_role
language sql
stable
security definer
set search_path = app, public
as $$
  select s.role
  from app.profiles p
  join app.staff s on s.id = p.staff_id
  where p.user_id = auth.uid() and s.is_active;
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_role() = 'admin', false);
$$;

-- -----------------------------------------------------------------------------
-- SKU 生成
--   {通番号}-{仕入担当コード}{納品担当コード}-{購入日YYYYMMDD}-{仕入金額÷10}
--   例) 2340-EEMM-20260916-1296  (通番2340 / 石川→吉光 / 2026-09-16 / ¥12,961)
-- -----------------------------------------------------------------------------
create or replace function app.build_sku(
  p_lot_seq       integer,
  p_purchaser_code char(2),
  p_deliverer_code char(2),
  p_purchased_at  date,
  p_cost_amount   bigint
)
returns text
language sql
immutable
as $$
  select format(
    '%s-%s-%s-%s',
    p_lot_seq,
    -- 担当者が片方しかいない行は中央ブロックが 2 文字になる（実データ準拠）
    coalesce(p_purchaser_code, '') || coalesce(p_deliverer_code, ''),
    to_char(coalesce(p_purchased_at, current_date), 'YYYYMMDD'),
    (coalesce(p_cost_amount, 0) / 10)::bigint
  );
$$;

comment on function app.build_sku is '出品者SKUを組み立てる。仕入金額は10円単位に切り捨てる（スプレッドシート時代の慣習を踏襲）。担当者が片方だけの場合、中央ブロックは2文字になる。';

-- SKU から情報を読み戻す（納品担当アプリの SKU 検索・スキャン用）
create or replace function app.parse_sku(p_sku text)
returns table (lot_seq text, purchaser_code text, deliverer_code text, purchased_at date, cost_amount bigint)
language sql
immutable
as $$
  select
    parts[1],
    substring(parts[2] from 1 for 2),
    substring(parts[2] from 3 for 2),
    to_date(parts[3], 'YYYYMMDD'),
    (parts[4])::bigint * 10
  from (select string_to_array(p_sku, '-') as parts) s
  where array_length(parts, 1) = 4;
$$;

-- items の INSERT 時に SKU / ロットを自動採番する
create or replace function app.items_before_insert()
returns trigger
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_purchaser_code char(2);
  v_deliverer_code char(2);
begin
  -- 通番号が未指定なら新規採番
  if new.lot_seq is null then
    new.lot_seq := nextval('app.lot_seq_counter');
  end if;

  insert into app.lots(seq) values (new.lot_seq) on conflict (seq) do nothing;

  -- SKU が未指定なら組み立てる（移行時は既存 SKU をそのまま渡す）
  if new.sku is null then
    select code into v_purchaser_code from app.staff where id = new.purchaser_id;
    select code into v_deliverer_code from app.staff where id = new.deliverer_id;

    if v_purchaser_code is null and v_deliverer_code is null then
      raise exception 'SKU を発番するには仕入担当者か納品担当者のどちらかが必要です';
    end if;

    new.sku := app.build_sku(
      new.lot_seq, v_purchaser_code, v_deliverer_code, new.purchased_at, new.cost_amount
    );
  end if;

  -- 商品マスタが指定されていれば ASIN を補完
  if new.asin is null and new.product_id is not null then
    select p.asin into new.asin from app.products p where p.id = new.product_id;
  end if;

  -- 古物台帳: ネット仕入れは非対面取引として取引記録で確認する
  if new.identity_check is null then
    new.identity_check := case
      when new.cost_amount < 10000 then '確認不要(1万円未満)'::app.identity_check_method
      else '非対面(取引記録)'::app.identity_check_method
    end;
    new.identity_checked_on := coalesce(new.identity_checked_on, new.purchased_at);
  end if;

  if new.created_by is null then
    new.created_by := app.current_staff_id();
  end if;

  return new;
end;
$$;

drop trigger if exists items_before_insert on app.items;
create trigger items_before_insert
  before insert on app.items
  for each row execute function app.items_before_insert();

-- -----------------------------------------------------------------------------
-- 作業チェックの状態を status に反映する
-- -----------------------------------------------------------------------------
create or replace function app.items_sync_status()
returns trigger
language plpgsql
as $$
begin
  -- 手動で設定された終端ステータスは尊重する
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then
    return new;
  end if;

  -- Amazon から戻ってきた個体は、再出荷するまで「Amazon返品」のまま。
  -- 既に作業済みの個体が返ってくるので、過去の作業チェックは消さずに残す。
  -- 返品日が分からない行（移行元に日付が無かったもの）でも印だけは保てるよう、
  -- 日付と status のどちらかが立っていれば返品扱いにする。
  if new.amazon_returned_on is not null or new.status = 'Amazon返品' then
    if new.shipped_on is not null
       and (new.amazon_returned_on is null or new.shipped_on > new.amazon_returned_on) then
      null;   -- 返品後に出荷し直したので、通常の進捗に戻す
    else
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;

  new.status := case
    when new.shipped_on is not null then '出荷済'
    when new.product_registered_at is not null
      or new.inspected_at is not null
      or new.photo_uploaded_at is not null
      or new.packed_on is not null then '作業中'
    when new.arrived_on is not null then '入荷済'
    else '仕入済'
  end;

  -- 出荷済みかつ出品日が入っていれば出品中
  if new.listed_on is not null and new.status = '出荷済' then
    new.status := '出品中';
  end if;

  return new;
end;
$$;

drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status
  before insert or update of arrived_on, product_registered_at, inspected_at,
                             photo_uploaded_at, packed_on, shipped_on, listed_on,
                             amazon_returned_on
  on app.items
  for each row execute function app.items_sync_status();

-- 販売登録時に status を 販売済 に倒す
create or replace function app.items_mark_sold()
returns trigger
language plpgsql
as $$
begin
  -- Amazon から返品された個体は、売れた記録が残っていても「戻ってきた」が優先
  if new.sold_on is not null
     and new.status <> '返品処理'
     and new.amazon_returned_on is null then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then
    new.status := '返品処理';
  end if;
  return new;
end;
$$;

drop trigger if exists items_mark_sold on app.items;
create trigger items_mark_sold
  before insert or update of sold_on, returned_on on app.items
  for each row execute function app.items_mark_sold();

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['staff', 'payment_cards', 'products', 'items', 'expenses']
  loop
    execute format(
      'drop trigger if exists %I_touch_updated_at on app.%I', t, t);
    execute format(
      'create trigger %I_touch_updated_at before update on app.%I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 監査ログ（items は古物台帳を兼ねるため全変更を残す）
-- -----------------------------------------------------------------------------
create or replace function app.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = app, public
as $$
begin
  insert into app.audit_log(table_name, row_id, action, changed_by, old_data, new_data)
  values (
    tg_table_name,
    coalesce(new.id, old.id),
    tg_op,
    app.current_staff_id(),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists items_audit on app.items;
create trigger items_audit
  after insert or update or delete on app.items
  for each row execute function app.write_audit_log();

-- -----------------------------------------------------------------------------
-- 納品担当アプリ用 RPC
--   Postgres の RLS は行単位でしか制御できないため、
--   「担当分の作業列だけ更新してよい」という制約は SECURITY DEFINER 関数で表現する。
--   納品担当者には items への UPDATE 権限を一切与えない（RLS + GRANT の二重防御）。
-- -----------------------------------------------------------------------------
create or replace function app.assert_can_work_on(p_item_id uuid)
returns app.items
language plpgsql
stable
security definer
set search_path = app, public
as $$
declare
  v_item app.items;
  v_staff uuid := app.current_staff_id();
begin
  if v_staff is null then
    raise exception 'ログインしていません' using errcode = '42501';
  end if;

  select * into v_item from app.items where id = p_item_id;
  if not found then
    raise exception 'SKU が見つかりません' using errcode = 'P0002';
  end if;

  if not app.is_admin() and v_item.deliverer_id is distinct from v_staff then
    raise exception 'この商品はあなたの担当ではありません' using errcode = '42501';
  end if;

  return v_item;
end;
$$;

-- 作業チェックの ON/OFF
create or replace function app.set_work_progress(
  p_item_id uuid,
  p_step    text,      -- 'arrived' | 'registered' | 'inspected' | 'photo' | 'packed' | 'shipped'
  p_done    boolean default true
)
returns app.items
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_item app.items;
begin
  if p_step not in ('arrived', 'registered', 'inspected', 'photo', 'packed', 'shipped') then
    raise exception '不明な作業ステップです: %', p_step using errcode = '22023';
  end if;

  perform app.assert_can_work_on(p_item_id);

  update app.items set
    arrived_on            = case when p_step = 'arrived'    then (case when p_done then current_date else null end) else arrived_on end,
    product_registered_at = case when p_step = 'registered' then (case when p_done then now()        else null end) else product_registered_at end,
    inspected_at          = case when p_step = 'inspected'  then (case when p_done then now()        else null end) else inspected_at end,
    photo_uploaded_at     = case when p_step = 'photo'      then (case when p_done then now()        else null end) else photo_uploaded_at end,
    packed_on             = case when p_step = 'packed'     then (case when p_done then current_date else null end) else packed_on end,
    shipped_on            = case when p_step = 'shipped'    then (case when p_done then current_date else null end) else shipped_on end
  where id = p_item_id
  returning * into v_item;

  return v_item;
end;
$$;

-- 納品担当者が直せてよい項目だけを更新する
create or replace function app.update_delivery_fields(
  p_item_id     uuid,
  p_accessories text default null,
  p_condition   app.item_condition default null,
  p_tracking_no text default null,
  p_memo        text default null
)
returns app.items
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_item app.items;
begin
  perform app.assert_can_work_on(p_item_id);

  update app.items set
    accessories = coalesce(p_accessories, accessories),
    condition   = coalesce(p_condition, condition),
    tracking_no = coalesce(p_tracking_no, tracking_no),
    memo        = coalesce(p_memo, memo)
  where id = p_item_id
  returning * into v_item;

  return v_item;
end;
$$;

-- SKU から担当商品を引く（バーコード/SKU スキャン用）
create or replace function app.find_by_sku(p_sku text)
returns app.items
language sql
stable
security definer
set search_path = app, public
as $$
  select i.* from app.items i
  where i.sku = btrim(p_sku)
    and (app.is_admin() or i.deliverer_id = app.current_staff_id());
$$;


-- ▼▼▼ 20260920000300_views.sql ▼▼▼

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


-- ▼▼▼ 20260920000400_rls.sql ▼▼▼

-- =============================================================================
-- 権限 / RLS
--
-- 方針
--   admin      : 大元アプリ。全テーブル読み書き。
--   purchaser  : 仕入担当。商品・仕入れの登録と全在庫の閲覧。経費は見るだけ。
--   deliverer  : 納品担当アプリ。自分が担当する SKU だけ閲覧でき、
--                更新は RPC（app.set_work_progress など）経由に限定する。
-- =============================================================================

grant usage on schema app to authenticated, service_role;

alter table app.staff          enable row level security;
alter table app.profiles       enable row level security;
alter table app.payment_cards  enable row level security;
alter table app.products       enable row level security;
alter table app.lots           enable row level security;
alter table app.items          enable row level security;
alter table app.item_photos    enable row level security;
alter table app.item_comments  enable row level security;
alter table app.expenses       enable row level security;
alter table app.audit_log      enable row level security;

-- -----------------------------------------------------------------------------
-- テーブル権限（RLS の手前の壁）
--   納品担当者に items の UPDATE を渡さないため、GRANT の段階で書き込みを絞る。
--   ただし GRANT はロール単位でしか効かず Supabase の利用者は全員 authenticated なので、
--   実質的な制御は RLS ポリシーが担う。ここは「読み取りは全員／更新は RLS 次第」とする。
-- -----------------------------------------------------------------------------
grant select on all tables in schema app to authenticated;
grant insert, update, delete on
  app.items, app.item_photos, app.item_comments, app.products,
  app.payment_cards, app.expenses, app.staff, app.lots
  to authenticated;
grant usage, select on all sequences in schema app to authenticated;

-- -----------------------------------------------------------------------------
-- staff
-- -----------------------------------------------------------------------------
drop policy if exists staff_select on app.staff;
create policy staff_select on app.staff
  for select to authenticated using (true);

drop policy if exists staff_write on app.staff;
create policy staff_write on app.staff
  for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- -----------------------------------------------------------------------------
-- profiles（自分の紐付けだけ見える）
-- -----------------------------------------------------------------------------
drop policy if exists profiles_select on app.profiles;
create policy profiles_select on app.profiles
  for select to authenticated
  using (user_id = auth.uid() or app.is_admin());

-- -----------------------------------------------------------------------------
-- payment_cards / expenses は経理情報なので管理者のみ
-- -----------------------------------------------------------------------------
drop policy if exists cards_admin on app.payment_cards;
create policy cards_admin on app.payment_cards
  for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

drop policy if exists expenses_admin on app.expenses;
create policy expenses_admin on app.expenses
  for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- -----------------------------------------------------------------------------
-- products（仕入れ判断に使うので仕入担当まで書き込み可）
-- -----------------------------------------------------------------------------
drop policy if exists products_select on app.products;
create policy products_select on app.products
  for select to authenticated using (true);

drop policy if exists products_write on app.products;
create policy products_write on app.products
  for all to authenticated
  using (app.current_role() in ('admin', 'purchaser'))
  with check (app.current_role() in ('admin', 'purchaser'));

drop policy if exists lots_select on app.lots;
create policy lots_select on app.lots
  for select to authenticated using (true);

drop policy if exists lots_write on app.lots;
create policy lots_write on app.lots
  for all to authenticated
  using (app.current_role() in ('admin', 'purchaser'))
  with check (app.current_role() in ('admin', 'purchaser'));

-- -----------------------------------------------------------------------------
-- items
-- -----------------------------------------------------------------------------
-- 閲覧: 管理者・仕入担当は全件／納品担当は自分の担当分のみ
drop policy if exists items_select on app.items;
create policy items_select on app.items
  for select to authenticated
  using (
    app.current_role() in ('admin', 'purchaser')
    or deliverer_id = app.current_staff_id()
  );

-- 登録: 管理者・仕入担当のみ
drop policy if exists items_insert on app.items;
create policy items_insert on app.items
  for insert to authenticated
  with check (app.current_role() in ('admin', 'purchaser'));

-- 直接更新: 管理者・仕入担当のみ。
-- 納品担当者は app.set_work_progress / app.update_delivery_fields を使う。
drop policy if exists items_update on app.items;
create policy items_update on app.items
  for update to authenticated
  using (app.current_role() in ('admin', 'purchaser'))
  with check (app.current_role() in ('admin', 'purchaser'));

-- 削除は管理者のみ（古物台帳の証跡なので原則は論理削除＝status '廃棄'）
drop policy if exists items_delete on app.items;
create policy items_delete on app.items
  for delete to authenticated
  using (app.is_admin());

-- -----------------------------------------------------------------------------
-- item_photos / item_comments（担当している SKU なら納品担当者も書ける）
-- -----------------------------------------------------------------------------
drop policy if exists item_photos_select on app.item_photos;
create policy item_photos_select on app.item_photos
  for select to authenticated
  using (exists (
    select 1 from app.items i
    where i.id = item_id
      and (app.current_role() in ('admin', 'purchaser')
           or i.deliverer_id = app.current_staff_id())
  ));

drop policy if exists item_photos_insert on app.item_photos;
create policy item_photos_insert on app.item_photos
  for insert to authenticated
  with check (exists (
    select 1 from app.items i
    where i.id = item_id
      and (app.current_role() in ('admin', 'purchaser')
           or i.deliverer_id = app.current_staff_id())
  ));

drop policy if exists item_photos_delete on app.item_photos;
create policy item_photos_delete on app.item_photos
  for delete to authenticated
  using (
    app.is_admin()
    or uploaded_by = app.current_staff_id()
  );

drop policy if exists item_comments_select on app.item_comments;
create policy item_comments_select on app.item_comments
  for select to authenticated
  using (exists (
    select 1 from app.items i
    where i.id = item_id
      and (app.current_role() in ('admin', 'purchaser')
           or i.deliverer_id = app.current_staff_id())
  ));

drop policy if exists item_comments_insert on app.item_comments;
create policy item_comments_insert on app.item_comments
  for insert to authenticated
  with check (
    author_id = app.current_staff_id()
    and exists (
      select 1 from app.items i
      where i.id = item_id
        and (app.current_role() in ('admin', 'purchaser')
             or i.deliverer_id = app.current_staff_id())
    )
  );

-- コメントは会話の記録なので編集不可、削除は管理者のみ
drop policy if exists item_comments_delete on app.item_comments;
create policy item_comments_delete on app.item_comments
  for delete to authenticated using (app.is_admin());

-- -----------------------------------------------------------------------------
-- audit_log は読むだけ（書き込みはトリガーの SECURITY DEFINER のみ）
-- -----------------------------------------------------------------------------
drop policy if exists audit_admin_select on app.audit_log;
create policy audit_admin_select on app.audit_log
  for select to authenticated using (app.is_admin());

-- -----------------------------------------------------------------------------
-- RPC の実行権限
-- -----------------------------------------------------------------------------
grant execute on function
  app.current_staff_id(),
  app.current_role(),
  app.is_admin(),
  app.build_sku(integer, char, char, date, bigint),
  app.parse_sku(text),
  app.set_work_progress(uuid, text, boolean),
  app.update_delivery_fields(uuid, text, app.item_condition, text, text),
  app.find_by_sku(text)
  to authenticated;

-- ビューはオーナー（postgres）経由で参照されるため、明示的に SELECT を渡す
grant select on
  app.v_items, app.v_delivery_tasks, app.v_antique_ledger,
  app.v_monthly_summary, app.v_stock_summary,
  app.v_deliverer_workload, app.v_product_performance
  to authenticated;

-- -----------------------------------------------------------------------------
-- Storage: 商品写真バケット
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', false)
on conflict (id) do nothing;

-- パスは {sku}/{uuid}.jpg とする
drop policy if exists "item photos are readable by staff in charge" on storage.objects;
create policy "item photos are readable by staff in charge"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'item-photos'
    and exists (
      select 1 from app.items i
      where i.sku = split_part(name, '/', 1)
        and (app.current_role() in ('admin', 'purchaser')
             or i.deliverer_id = app.current_staff_id())
    )
  );

drop policy if exists "item photos are writable by staff in charge" on storage.objects;
create policy "item photos are writable by staff in charge"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-photos'
    and exists (
      select 1 from app.items i
      where i.sku = split_part(name, '/', 1)
        and (app.current_role() in ('admin', 'purchaser')
             or i.deliverer_id = app.current_staff_id())
    )
  );


-- ▼▼▼ 20260920000500_seed_master.sql ▼▼▼

-- =============================================================================
-- マスタ初期データ
--   スプレッドシートの SKU から読み取れる担当者コードをそのまま採用する。
--   （既存 SKU を壊さないために、このコード表は変更しないこと）
-- =============================================================================

-- このコード表は納品管理表 全 3,161 行の SKU から実際に読み取ったもので、
-- 1 コードにつき担当者は 1 人、食い違いは 0 件だった。
insert into app.staff (code, name, role, is_company, is_active) values
  ('AA', '長部一輝',            'admin',     false, true),
  ('EE', '石川秀樹',            'purchaser', false, true),
  ('DD', '久保田ゆかり',        'deliverer', false, true),
  ('HH', '新川水紀',            'deliverer', false, true),
  ('II', '久保田真由',          'deliverer', false, true),
  ('JJ', '神谷愛',              'deliverer', false, true),
  ('GG', '和田知佳',            'deliverer', false, true),
  ('LL', '土井花菜',            'deliverer', false, true),
  ('FF', '株式会社グレイス',    'deliverer', true,  true),
  ('KK', '株式会社コエル',      'deliverer', true,  true),
  ('MM', '株式会社吉光',        'deliverer', true,  true),
  -- 「辞めた方」シートの担当者。過去の SKU が参照するので消さずに残す
  ('BB', '大長美賀',            'deliverer', false, false),
  ('CC', '平岡拓海',            'deliverer', false, false)
on conflict (code) do nothing;

-- 納品管理表の「クレカ」列に現れた支払い手段をすべて登録する
-- （現金・メルカリ残高はカードではないが、支払い元として同じ列で管理されている）
insert into app.payment_cards (name, last4, credit_limit, closing_day, payment_day) values
  ('三井住友',      '0137', null,     '15',  10),
  ('楽天',          '4061', null,     '末',  27),
  ('メルカード',    '5992', 900000,   '末',  26),
  ('PayPay',        '3797', 2000000,  '末',  27),
  ('セゾン',        null,   null,     '末',  4),
  ('アメックス',    null,   null,     '末',  10),
  ('Dカード',       null,   null,     '末',  10),
  ('現金',          null,   null,     null,  null),
  ('メルカリ残高',  null,   null,     null,  null)
on conflict (name) do nothing;

-- Amazon 出品テンプレート用のコンディション変換表
create table if not exists app.condition_map (
  condition app.item_condition primary key,
  amazon_code text not null
);

insert into app.condition_map (condition, amazon_code) values
  ('新品',       'New'),
  ('再生品',     'Refurbished'),
  ('ほぼ新品',   'UsedLikeNew'),
  ('非常に良い', 'UsedVeryGood'),
  ('良い',       'UsedGood'),
  ('可',         'UsedAcceptable'),
  ('ジャンク',   'UsedAcceptable')
on conflict (condition) do nothing;

alter table app.condition_map enable row level security;
grant select on app.condition_map to authenticated;
drop policy if exists condition_map_select on app.condition_map;
create policy condition_map_select on app.condition_map
  for select to authenticated using (true);


-- ▼▼▼ 20260920000600_amazon_feed.sql ▼▼▼

-- =============================================================================
-- Amazon 出品用フィード
--   納品管理表の「出品テンプレート」シートを置き換える。
--   写真登録まで終わった SKU を、Amazon の在庫ファイル形式で出力する。
-- =============================================================================
drop view if exists app.v_amazon_listing_feed cascade;
create view app.v_amazon_listing_feed with (security_invoker = on) as
select
  i.sku                                     as "sku",
  i.planned_price                           as "price",
  1                                         as "quantity",
  i.asin                                    as "product-id",
  'ASIN'                                    as "product-id-type",
  cm.amazon_code                            as "condition-type",
  i.description                             as "condition-note",
  i.title                                   as "title",
  'Update'                                  as "operation-type",
  case i.sales_channel
    when 'FBA' then 'AMAZON_NA'
    else 'DEFAULT'
  end                                       as "fulfillment-center-id",
  (
    select 'https://' || current_setting('app.storage_host', true) || '/' || ph.storage_path
    from app.item_photos ph
    where ph.item_id = i.id and ph.is_main
    limit 1
  )                                         as "main-offer-image",
  i.id                                      as item_id,
  i.status,
  i.deliverer_id
from app.items i
left join app.condition_map cm on cm.condition = i.condition
where i.asin is not null
  and i.planned_price is not null
  and i.photo_uploaded_at is not null
  and i.status in ('作業中', '出荷済', '出品中');

grant select on app.v_amazon_listing_feed to authenticated;


-- ▼▼▼ 20260920000700_link_login.sql ▼▼▼

-- =============================================================================
-- ログインアカウントと担当者の紐付け
--
--   Supabase の Authentication で作ったアカウントを、app.staff の誰かに結びつける。
--   紐付いていないアカウントはログインしてもアプリを開けない（意図的な作り）。
--
--   使い方（SQL Editor で実行）
--     select app.link_login('kubota@example.com', 'DD');
-- =============================================================================

create or replace function app.link_login(p_email text, p_staff_code text)
returns text
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_user     uuid;
  v_staff    uuid;
  v_name     text;
  v_role     app.staff_role;
  v_email    text := lower(btrim(p_email));
  v_code     text := upper(btrim(p_staff_code));
begin
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    raise exception 'メールアドレス % のアカウントが見つかりません', v_email
      using hint = 'Supabase の Authentication → Users → Add user で、'
                   'このメールアドレスのアカウントを先に作ってください。';
  end if;

  select id, name, role into v_staff, v_name, v_role from app.staff where code = v_code;
  if v_staff is null then
    raise exception '担当者コード % が見つかりません', v_code
      using hint = 'select code, name from app.staff order by code; で一覧を確認できます。';
  end if;

  -- 同じ担当者に別のアカウントが紐付いていたら、新しいほうに付け替える
  delete from app.profiles where staff_id = v_staff and user_id <> v_user;

  insert into app.profiles (user_id, staff_id)
  values (v_user, v_staff)
  on conflict (user_id) do update set staff_id = excluded.staff_id;

  update app.staff set email = v_email where id = v_staff;

  return format('%s（%s / %s）を %s に紐付けました', v_name, v_code, v_role, v_email);
end;
$$;

comment on function app.link_login is
  'Authentication のアカウントを app.staff に紐付ける。SQL Editor から select app.link_login(メール, コード); で使う。';

-- -----------------------------------------------------------------------------
-- 紐付けの一覧（誰がログインできるか）
-- -----------------------------------------------------------------------------
create or replace view app.v_logins with (security_invoker = on) as
select
  s.code,
  s.name       as 担当者,
  s.role       as 役割,
  s.is_active  as 在籍,
  s.email,
  (p.user_id is not null) as ログイン可能
from app.staff s
left join app.profiles p on p.staff_id = s.id
order by s.code;

grant select on app.v_logins to authenticated;


-- ▼▼▼ 20260927063022_amazon_payment_history.sql ▼▼▼

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


-- ▼▼▼ 20260927063954_restrict_login_linking_to_operators.sql ▼▼▼

-- Account linking is an operator-only action; normal login does not use this function.
revoke execute on function app.link_login(text, text) from public, anon, authenticated;
grant execute on function app.link_login(text, text) to service_role;


-- ▼▼▼ 20260927074728_amazon_inventory_sale_reconciliation.sql ▼▼▼

create table app.amazon_sale_matches (
  item_id uuid primary key references app.items(id),
  account_key text not null,
  transaction_id text not null,
  sku text not null,
  sold_on date not null,
  sold_price bigint not null check (sold_price >= 0),
  payout_amount bigint not null check (payout_amount >= 0),
  applied_by uuid not null references auth.users(id),
  applied_at timestamptz not null default now(),
  unique(account_key, transaction_id, sku)
);
alter table app.amazon_sale_matches enable row level security;
revoke all on app.amazon_sale_matches from public, anon, authenticated;
grant select, insert, update on app.amazon_sale_matches to service_role;
comment on table app.amazon_sale_matches is 'Exact-SKU Amazon sale reconciliation provenance. Does not store buyer details.';

create or replace function app.apply_amazon_sale(
  p_account text, p_transaction text, p_sku text, p_asin text,
  p_sold_on date, p_price bigint, p_payout bigint, p_actor uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  inventory app.items%rowtype;
  previous app.amazon_sale_matches%rowtype;
  evidence jsonb;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id
      where p.user_id=p_actor and s.role='admin' and s.is_active) then
    raise exception 'Administrator required';
  end if;
  if p_sold_on is null or p_sold_on > (now() at time zone 'Asia/Tokyo')::date
      or p_price is null or p_payout is null or p_price < 0 or p_payout < 0 then
    raise exception 'Invalid sale';
  end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
    where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528'
      and t.transaction_type='Shipment' and t.status in ('RELEASED','DEFERRED_RELEASED');
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku) <> 1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY'
        and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  select * into inventory from app.items where sku=p_sku for update;
  if not found then return jsonb_build_object('status','review','reason','一致するSKUが在庫一覧にありません。'); end if;
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then
    return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。');
  end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then
    return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。');
  end if;
  if inventory.status in ('返品処理','Amazon返品','廃棄') or inventory.amazon_returned_on is not null
      or inventory.returned_on is not null or (inventory.purchased_at is not null and inventory.purchased_at > p_sold_on) then
    return jsonb_build_object('status','review','reason','返品・廃棄、または仕入日より前の販売のため確認が必要です。');
  end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then
      return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。');
    end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price
      or inventory.payout_amount is distinct from previous.payout_amount then
      return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。');
    end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then
      return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。');
    end if;
  elsif (inventory.sold_on is not null and inventory.sold_on<>p_sold_on)
      or (inventory.sold_price is not null and inventory.sold_price<>p_price)
      or (inventory.payout_amount is not null and inventory.payout_amount<>p_payout) then
    return jsonb_build_object('status','review','reason','既存の販売記録と異なります。自動上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by)
    values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
    on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,
      payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を反映しました。');
end;
$$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;


-- ▼▼▼ 20260927074917_amazon_reconciliation_service_permissions.sql ▼▼▼

grant select on app.items, app.staff, app.profiles to service_role;
grant update (sold_on,sold_price,payout_amount) on app.items to service_role;


-- ▼▼▼ 20260927082428_inventory_product_groups.sql ▼▼▼

create or replace view app.v_product_groups with (security_invoker = true) as
with grouped as (
  select lot_seq, count(*)::integer as product_row_count, sum(cost_amount)::bigint as product_cost,
    count(*) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))::integer as sale_row_count,
    count(distinct (sold_on,sold_price,payout_amount)) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as signatures,
    bool_or(sold_on is not null and sold_price is null and not is_accessory) as missing_price,
    min(sold_on) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_date,
    max(sold_price) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_price,
    max(payout_amount) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_payout
  from app.items group by lot_seq
)
select lot_seq,product_row_count,product_cost,sale_row_count,
  (signatures > 1 or coalesce(missing_price,false)) as product_sale_conflict,
  case when signatures=1 and not coalesce(missing_price,false) then sale_date end as product_sold_on,
  case when signatures=1 and not coalesce(missing_price,false) then sale_price end as product_sold_price,
  case when signatures=1 and not coalesce(missing_price,false) then sale_payout end as product_payout_amount
from grouped;
grant select on app.v_product_groups to authenticated,service_role;
create or replace view app.v_inventory_items with (security_invoker = true) as
select i.*,g.product_row_count,g.product_cost,g.sale_row_count,g.product_sale_conflict,
  g.product_sold_on,g.product_sold_price,g.product_payout_amount
from app.v_items i join app.v_product_groups g using(lot_seq);
grant select on app.v_inventory_items to authenticated;
create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then return new; end if;
  perform pg_advisory_xact_lock(179049,new.lot_seq);
  if exists(select 1 from app.items i where i.lot_seq=new.lot_seq and i.id<>new.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    raise exception '同じ通番号の商品に販売記録があります。売上を重複登録できません。';
  end if;
  return new;
end; $$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;
create trigger items_single_product_sale before insert or update of sold_on,sold_price,payout_amount on app.items
for each row execute function app.guard_single_product_sale();


-- ▼▼▼ 20260927082703_amazon_reconcile_same_product.sql ▼▼▼

create or replace function app.apply_amazon_sale(
  p_account text, p_transaction text, p_sku text, p_asin text,
  p_sold_on date, p_price bigint, p_payout bigint, p_actor uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  inventory app.items%rowtype;
  previous app.amazon_sale_matches%rowtype;
  evidence jsonb;
  target_id uuid;
  target_lot integer;
  target_count integer;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id
      where p.user_id=p_actor and s.role='admin' and s.is_active) then
    raise exception 'Administrator required';
  end if;
  if p_sold_on is null or p_sold_on > (now() at time zone 'Asia/Tokyo')::date
      or p_price is null or p_payout is null or p_price < 0 or p_payout < 0 then
    raise exception 'Invalid sale';
  end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
    where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528'
      and t.transaction_type='Shipment' and t.status in ('RELEASED','DEFERRED_RELEASED');
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku) <> 1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY'
        and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  select id,lot_seq into target_id,target_lot from app.items where sku=p_sku;
  if target_id is null and p_sku ~ '^[0-9]{1,9}[a-z]?[-_]' then
    target_lot := substring(p_sku from '^([0-9]{1,9})')::integer;
    select count(*),min(id::text)::uuid into target_count,target_id from app.items where lot_seq=target_lot and not is_accessory;
    if target_count<>1 then return jsonb_build_object('status','review','reason','同じ通番号の本体行を1件に特定できません。'); end if;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・通番号が在庫一覧にありません。'); end if;
  perform pg_advisory_xact_lock(179049,target_lot);
  select * into inventory from app.items where id=target_id for update;
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then
    return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。');
  end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then
    return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。');
  end if;
  if inventory.status in ('返品処理','Amazon返品','廃棄') or inventory.amazon_returned_on is not null
      or inventory.returned_on is not null or (inventory.purchased_at is not null and inventory.purchased_at > p_sold_on) then
    return jsonb_build_object('status','review','reason','返品・廃棄、または仕入日より前の販売のため確認が必要です。');
  end if;
  if exists(select 1 from app.items i where i.lot_seq=inventory.lot_seq and i.id<>inventory.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    if exists(select 1 from app.items i where i.lot_seq=inventory.lot_seq and i.id<>inventory.id and i.sold_on is not null
        and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
        and (i.sold_on is distinct from p_sold_on or i.sold_price is distinct from p_price or i.payout_amount is distinct from p_payout)) then
      return jsonb_build_object('status','review','reason','同じ通番号に異なる販売記録があります。自動上書きしません。');
    end if;
    return jsonb_build_object('status','unchanged','reason','同じ通番号の商品に同じ販売内容を登録済みです。重複記入しません。');
  end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then
      return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。');
    end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price
      or inventory.payout_amount is distinct from previous.payout_amount then
      return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。');
    end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then
      return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。');
    end if;
  elsif (inventory.sold_on is not null and inventory.sold_on<>p_sold_on)
      or (inventory.sold_price is not null and inventory.sold_price<>p_price)
      or (inventory.payout_amount is not null and inventory.payout_amount<>p_payout) then
    return jsonb_build_object('status','review','reason','既存の販売記録と異なります。自動上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by)
    values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
    on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,
      payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を反映しました。');
end;
$$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;


-- ▼▼▼ 20260927083232_product_sale_missing_price_validation.sql ▼▼▼

create or replace view app.v_product_groups with (security_invoker = true) as
with grouped as (
  select lot_seq, count(*)::integer as product_row_count, sum(cost_amount)::bigint as product_cost,
    count(*) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))::integer as sale_row_count,
    count(distinct (sold_on,sold_price,payout_amount)) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as signatures,
    bool_or(sold_on is not null and sold_price is null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as missing_price,
    min(sold_on) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_date,
    max(sold_price) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_price,
    max(payout_amount) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_payout
  from app.items group by lot_seq
)
select lot_seq,product_row_count,product_cost,sale_row_count,
  (signatures > 1 or coalesce(missing_price,false)) as product_sale_conflict,
  case when signatures=1 and not coalesce(missing_price,false) then sale_date end as product_sold_on,
  case when signatures=1 and not coalesce(missing_price,false) then sale_price end as product_sold_price,
  case when signatures=1 and not coalesce(missing_price,false) then sale_payout end as product_payout_amount
from grouped;


-- ▼▼▼ 20260927102345_expense_refunds_and_product_counts.sql ▼▼▼

-- Expense refunds reduce expense totals; retain existing access policies.
ALTER TABLE app.expenses DROP CONSTRAINT expenses_amount_check;
ALTER TABLE app.expenses ADD CONSTRAINT expenses_amount_check CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991);
CREATE OR REPLACE VIEW app.v_monthly_summary WITH (security_invoker = true) AS  WITH purchased AS (
         SELECT date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date AS month,
            count(*) AS "仕入数",
            sum(items.cost_amount) AS "仕入金額",
            avg(items.cost_amount)::bigint AS "平均仕入額"
           FROM app.items
          GROUP BY (date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date)
        ), sold AS (
         SELECT date_trunc('month'::text, items.sold_on::timestamp with time zone)::date AS month,
            count(DISTINCT items.lot_seq) FILTER (WHERE NOT (items.is_accessory AND COALESCE(items.sold_price, 0) = 0 AND COALESCE(items.payout_amount, 0) = 0)) AS "販売数",
            sum(items.sold_price) AS "売上",
            sum(items.payout_amount) AS "振込金額",
            sum(items.profit) AS "粗利益",
            avg(items.sold_price)::bigint AS "平均販売額",
            avg(items.sold_on - items.purchased_at)::numeric(10,1) AS "平均回転日数"
           FROM app.items
          WHERE items.sold_on IS NOT NULL
          GROUP BY (date_trunc('month'::text, items.sold_on::timestamp with time zone)::date)
        ), expense AS (
         SELECT date_trunc('month'::text, expenses.incurred_on::timestamp with time zone)::date AS month,
            sum(expenses.amount) AS "経費"
           FROM app.expenses
          GROUP BY (date_trunc('month'::text, expenses.incurred_on::timestamp with time zone)::date)
        )
 SELECT COALESCE(p.month, s.month, e.month) AS month,
    COALESCE(p."仕入数", 0::bigint) AS "仕入数",
    COALESCE(p."仕入金額", 0::numeric) AS "仕入金額",
    COALESCE(p."平均仕入額", 0::bigint) AS "平均仕入額",
    COALESCE(s."販売数", 0::bigint) AS "販売数",
    COALESCE(s."売上", 0::numeric) AS "売上",
    COALESCE(s."振込金額", 0::numeric) AS "振込金額",
    COALESCE(s."粗利益", 0::numeric) AS "粗利益",
    COALESCE(s."平均販売額", 0::bigint) AS "平均販売額",
    s."平均回転日数",
    COALESCE(e."経費", 0::numeric) AS "経費",
    COALESCE(s."粗利益", 0::numeric) - COALESCE(e."経費", 0::numeric) AS "純利益"
   FROM purchased p
     FULL JOIN sold s ON s.month = p.month
     FULL JOIN expense e ON e.month = COALESCE(p.month, s.month)
  ORDER BY (COALESCE(p.month, s.month, e.month)) DESC;
CREATE OR REPLACE VIEW app.v_stock_summary WITH (security_invoker = true) AS  SELECT count(DISTINCT lot_seq) AS "現在庫数",
    sum(cost_amount) AS "仕入金額合計",
    sum(COALESCE(planned_payout, 0::bigint)) AS "売上見込み合計",
    sum(COALESCE(planned_payout, 0::bigint) - cost_amount) AS "見込み利益合計",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) <= 7) AS "高回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 8 AND (CURRENT_DATE - purchased_at) <= 14) AS "中回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 15) AS "低回転",
    count(*) FILTER (WHERE status = '作業中'::app.item_status) AS "作業中",
    count(*) FILTER (WHERE status = '仕入済'::app.item_status) AS "入荷待ち"
   FROM app.items
  WHERE status <> ALL (ARRAY['販売済'::app.item_status, '返品処理'::app.item_status, '廃棄'::app.item_status]);


-- ▼▼▼ 20260927122855_delivery_five_steps_and_descriptions.sql ▼▼▼

alter table app.items add column if not exists cleaned_at timestamptz;
alter table app.items add column if not exists description_template text;
alter table app.items add column if not exists manufacture_year integer;
alter table app.items add constraint items_description_template_check check (description_template is null or description_template in ('小物','ブルーレイレコーダー','モニター','テレビ'));
alter table app.items add constraint items_manufacture_year_check check (manufacture_year is null or manufacture_year between 1900 and 2100);
-- Previously inspection and cleaning were one completed step.
update app.items set cleaned_at = inspected_at where cleaned_at is null and inspected_at is not null;
CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- 手動で設定された終端ステータスは尊重する
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then
    return new;
  end if;

  -- Amazon から戻ってきた個体は、再出荷するまで「Amazon返品」のまま。
  -- 既に作業済みの個体が返ってくるので、過去の作業チェックは消さずに残す。
  -- 返品日が分からない行（移行元に日付が無かったもの）でも印だけは保てるよう、
  -- 日付と status のどちらかが立っていれば返品扱いにする。
  if new.amazon_returned_on is not null or new.status = 'Amazon返品' then
    if new.shipped_on is not null
       and (new.amazon_returned_on is null or new.shipped_on > new.amazon_returned_on) then
      null;   -- 返品後に出荷し直したので、通常の進捗に戻す
    else
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;

  new.status := case
    when new.shipped_on is not null then '出荷済'
    when new.product_registered_at is not null
      or new.inspected_at is not null
      or new.cleaned_at is not null
      or new.photo_uploaded_at is not null
      or new.packed_on is not null then '作業中'
    when new.arrived_on is not null then '入荷済'
    else '仕入済'
  end;

  -- 出荷済みかつ出品日が入っていれば出品中
  if new.listed_on is not null and new.status = '出荷済' then
    new.status := '出品中';
  end if;

  return new;
end;
$function$
;
drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status before insert or update of arrived_on, product_registered_at, inspected_at, cleaned_at, photo_uploaded_at, packed_on, shipped_on, listed_on, amazon_returned_on on app.items for each row execute function app.items_sync_status();

create or replace function app.set_work_progress(p_item_id uuid, p_step text, p_done boolean default true)
returns app.items language plpgsql security definer set search_path = app, public as $$
declare v_item app.items;
begin
  if p_step is null or p_done is null or p_step not in ('arrived','registered','inspected','cleaned','photo','listing','packed','shipped') then
    raise exception '不明な作業ステップです' using errcode = '22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  update app.items set
    arrived_on = case when p_step = 'arrived' then case when p_done then coalesce(arrived_on,current_date) else null end
      when p_done then coalesce(arrived_on,current_date) else arrived_on end,
    product_registered_at = case when p_step in ('registered','listing') then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
    inspected_at = case when p_step = 'inspected' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
    cleaned_at = case when p_step = 'cleaned' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
    photo_uploaded_at = case when p_step in ('photo','listing') then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
    packed_on = case when p_step = 'packed' then case when p_done then coalesce(packed_on,current_date) else null end else packed_on end,
    shipped_on = case when p_step = 'shipped' then case when p_done then coalesce(shipped_on,current_date) else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end;
$$;
revoke all on function app.set_work_progress(uuid,text,boolean) from public, anon;
grant execute on function app.set_work_progress(uuid,text,boolean) to authenticated;

create or replace function app.save_delivery_description(p_item_id uuid, p_condition app.item_condition, p_accessories text, p_description text, p_template text, p_manufacture_year integer)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.assert_can_work_on(p_item_id);
  if p_template is not null and p_template not in ('小物','ブルーレイレコーダー','モニター','テレビ') then
    raise exception '商品種別を確認してください' using errcode='22023';
  end if;
  if char_length(p_description)>10000 or char_length(p_accessories)>2000 then
    raise exception '入力文字数が上限を超えています' using errcode='22023';
  end if;
  update app.items set condition=p_condition, accessories=p_accessories, description=p_description,
    description_template=p_template, manufacture_year=p_manufacture_year where id=p_item_id;
end;
$$;
revoke all on function app.save_delivery_description(uuid,app.item_condition,text,text,text,integer) from public, anon;
grant execute on function app.save_delivery_description(uuid,app.item_condition,text,text,text,integer) to authenticated;

create or replace view app.v_delivery_tasks with (security_invoker=true) as
SELECT i.id,
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
    buyer.name AS purchaser_name,
    i.arrived_on,
    i.product_registered_at IS NOT NULL AS product_registered,
    i.inspected_at IS NOT NULL AS inspected,
    i.photo_uploaded_at IS NOT NULL AS photo_uploaded,
    i.packed_on,
    i.shipped_on,
    i.amazon_returned_on,
    p.image_url AS reference_image_url,
    ( SELECT count(*) AS count
           FROM app.item_photos ph
          WHERE ph.item_id = i.id) AS photo_count,
    ( SELECT max(cm.created_at) AS max
           FROM app.item_comments cm
          WHERE cm.item_id = i.id) AS last_comment_at,
    (i.cleaned_at is not null) as cleaned,
    i.description_template,
    i.manufacture_year
   FROM app.items i
     LEFT JOIN app.products p ON p.id = i.product_id
     LEFT JOIN app.staff buyer ON buyer.id = i.purchaser_id
  WHERE i.status = ANY (ARRAY['仕入済'::app.item_status, '入荷済'::app.item_status, '作業中'::app.item_status, 'Amazon返品'::app.item_status, '出荷済'::app.item_status, '出品中'::app.item_status, '販売済'::app.item_status]);
notify pgrst, 'reload schema';


-- ▼▼▼ 20260927135933_monthly_fixed_expense_drafts.sql ▼▼▼

create extension if not exists pg_cron with schema pg_catalog;
create table app.expense_drafts (
 id uuid primary key default gen_random_uuid(),
 target_month date not null check (extract(day from target_month)=1),
 name text not null check (length(trim(name))>0),
 card_id uuid references app.payment_cards(id),
 created_at timestamptz not null default now(),
 unique(target_month,name)
);
alter table app.expense_drafts enable row level security;
revoke all on app.expense_drafts from anon, authenticated;
grant select on app.expense_drafts to authenticated;
create policy expense_drafts_admin_read on app.expense_drafts for select to authenticated using(app.is_admin());
create function app.generate_next_month_fixed_expenses() returns integer language plpgsql security invoker set search_path = pg_catalog,app as $$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,name,card_id)
 select next_month,src.name,src.card_id from (
 select distinct on (name) name,card_id from (
 select name,card_id,updated_at from app.expenses where category='固定費' and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where e.category='固定費' and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
select cron.schedule('next-month-fixed-expense-drafts','55 14 * * *','select app.generate_next_month_fixed_expenses()');
notify pgrst,'reload schema';


-- ▼▼▼ 20260927140653_monthly_outsourcing_expense_drafts.sql ▼▼▼

alter table app.expense_drafts add column category text not null default '固定費' check(category in ('固定費','外注費'));
alter table app.expense_drafts drop constraint expense_drafts_target_month_name_key;
alter table app.expense_drafts add unique(target_month,category,name);
create or replace function app.generate_next_month_fixed_expenses() returns integer language plpgsql security invoker set search_path=pg_catalog,app as $$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,category,name,card_id)
 select next_month,src.category,src.name,src.card_id from (
 select distinct on (category,name) category,name,card_id from (
 select case when category::text='給与' then '外注費' else category::text end as category,name,card_id,updated_at
 from app.expenses where category::text in ('固定費','給与','外注費') and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.category,d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by category,name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where (case when e.category::text='給与' then '外注費' else e.category::text end)=src.category
 and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,category,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20260927142058_delivery_invoices.sql ▼▼▼

create table app.delivery_invoice_profiles (
 staff_id uuid primary key references app.staff(id),
 details jsonb not null check(jsonb_typeof(details)='object'),
 unit_price integer check(unit_price between 0 and 1000000),
 tax_percent integer not null default 0 check(tax_percent in (0,10)),
 enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
create table app.delivery_invoices (
 id uuid primary key default gen_random_uuid(),
 staff_id uuid not null references app.staff(id),
 billing_month date not null check(extract(day from billing_month)=1),
 issued_on date not null default (now() at time zone 'Asia/Tokyo')::date,
 extras jsonb not null default '[]'::jsonb check(jsonb_typeof(extras)='array'),
 note text not null default '' check(length(note)<=2000),
 snapshot jsonb not null,
 total bigint not null,
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(staff_id,billing_month)
);
alter table app.delivery_invoice_profiles enable row level security;
alter table app.delivery_invoices enable row level security;
revoke all on app.delivery_invoice_profiles,app.delivery_invoices from public,anon,authenticated;
grant select on app.delivery_invoice_profiles,app.delivery_invoices to authenticated;
grant insert(staff_id,billing_month,issued_on,extras,note) on app.delivery_invoices to authenticated;
grant update(issued_on,extras,note) on app.delivery_invoices to authenticated;
create policy invoice_profiles_read on app.delivery_invoice_profiles for select to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
create policy invoices_read on app.delivery_invoices for select to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
create policy invoices_insert on app.delivery_invoices for insert to authenticated
 with check (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
create policy invoices_update on app.delivery_invoices for update to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())))
 with check (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));

create function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception '請求書へのアクセス権がありません' using errcode='42501';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 -- One body per lot, regardless of supplier rows. Accessories never increase quantity.
 with bodies as (
 select distinct on (lot_seq) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title
 from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
 order by lot_seq,packed_on,id
 ), selected as (
 select * from bodies where packed_on>=p_month and packed_on<p_month+interval '1 month'
 )
 select coalesce(jsonb_agg(jsonb_build_object(
 'item_id',id,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
 'description',case when marketplace::text='Amazon返品' then 'Amazon返品対応'
 when work_stream::text='テレビ' then 'モニター・テレビ'
 when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
 'title',title,'quantity',1,'unit_price',p.unit_price,'amount',p.unit_price
 ) order by purchased_at nulls last,lot_seq),'[]'::jsonb),count(*)*p.unit_price into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

create function app.fill_delivery_invoice()
returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare doc jsonb; line jsonb; normalized jsonb:='[]'; qty integer; price bigint; sub bigint; tax bigint; date_value date;
begin
 if jsonb_typeof(new.extras)<>'array' or jsonb_array_length(new.extras)>100 then raise exception '追加明細は100行以内で入力してください'; end if;
 doc:=app.prepare_delivery_invoice(new.staff_id,new.billing_month);
 sub:=(doc->>'subtotal')::bigint;
 for line in select value from jsonb_array_elements(new.extras) loop
  if jsonb_typeof(line)<>'object' or length(trim(coalesce(line->>'description','')))=0 or length(line->>'description')>200
  or coalesce(line->>'quantity','') !~ '^[0-9]+$' or coalesce(line->>'unit_price','') !~ '^[0-9]+$' then
   raise exception '追加明細の内容・数量・単価を確認してください';
  end if;
  qty:=(line->>'quantity')::integer; price:=(line->>'unit_price')::bigint;
  if qty<1 or qty>100000 or price<0 or price>10000000 then raise exception '追加明細の金額が範囲外です'; end if;
  date_value:=nullif(line->>'date','')::date;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description',trim(line->>'description'),'quantity',qty,'unit_price',price,'amount',qty*price));
  sub:=sub+qty*price;
 end loop;
 tax:=floor(sub*(doc->>'tax_percent')::numeric/100);
 new.extras:=normalized;
 new.snapshot:=doc||jsonb_build_object('extras',normalized,'subtotal',sub,'tax',tax);
 new.total:=sub+tax;
 new.updated_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_delivery_invoice() from public,anon,authenticated;
create trigger fill_delivery_invoice before insert or update on app.delivery_invoices for each row execute function app.fill_delivery_invoice();
notify pgrst,'reload schema';


-- ▼▼▼ 20260927142132_delivery_invoice_profile_edit.sql ▼▼▼

grant update(details,unit_price) on app.delivery_invoice_profiles to authenticated;
create policy invoice_profiles_update on app.delivery_invoice_profiles for update to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())))
 with check (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
notify pgrst,'reload schema';


-- ▼▼▼ 20260927143313_invoice_approval_expenses.sql ▼▼▼

create or replace function app.generate_next_month_fixed_expenses() returns integer language plpgsql security invoker set search_path=pg_catalog,app as $$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,category,name,card_id)
 select next_month,'固定費',src.name,src.card_id from (
 select distinct on (name) name,card_id from (
 select name,card_id,updated_at from app.expenses where category::text='固定費' and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.category='固定費' and d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where e.category::text='固定費' and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,category,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
-- Remove only unfilled outsourcing placeholders; recorded expenses are preserved.
delete from app.expense_drafts d where d.category='外注費' and not exists(select 1 from app.expenses e where e.id=d.id);

create table app.delivery_invoice_approvals (
 invoice_id uuid primary key references app.delivery_invoices(id),
 expense_id uuid not null unique references app.expenses(id),
 approved_by uuid not null default app.current_staff_id() references app.staff(id),
 approved_at timestamptz not null default now()
);
alter table app.delivery_invoice_approvals enable row level security;
revoke all on app.delivery_invoice_approvals from public,anon,authenticated;
grant select on app.delivery_invoice_approvals to authenticated;
grant insert(invoice_id,expense_id) on app.delivery_invoice_approvals to authenticated;
create policy invoice_approvals_read on app.delivery_invoice_approvals for select to authenticated
 using (exists(select 1 from app.delivery_invoices i where i.id=invoice_id));
create policy invoice_approvals_insert on app.delivery_invoice_approvals for insert to authenticated
 with check ((select app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and approved_by=app.current_staff_id());

create function app.block_approved_invoice_changes() returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if exists(select 1 from app.delivery_invoice_approvals where invoice_id=old.id) then
  raise exception '承認済みの請求書は変更できません。管理者にご連絡ください。';
 end if;
 return new;
end $$;
revoke all on function app.block_approved_invoice_changes() from public,anon,authenticated;
create trigger a_block_approved_invoice_changes before update on app.delivery_invoices
 for each row execute function app.block_approved_invoice_changes();

create function app.approve_delivery_invoice(p_invoice uuid,p_version integer,p_incurred_on date)
returns uuid language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; existing uuid; expense uuid;
begin
 if auth.uid() is null or not app.is_admin()
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '請求書を承認できるのは管理者だけです' using errcode='42501';
 end if;
 select * into inv from app.delivery_invoices where id=p_invoice for update;
 if not found then raise exception '請求書が見つかりません'; end if;
 select expense_id into existing from app.delivery_invoice_approvals where invoice_id=inv.id;
 if found then return existing; end if;
 if inv.version<>p_version then raise exception '請求書が更新されました。最新の内容を確認してください'; end if;
 if p_incurred_on is null then raise exception '経費の計上日を指定してください'; end if;
 if inv.total<=0 then raise exception '請求金額が0円のため承認できません'; end if;
 insert into app.expenses(incurred_on,category,name,amount,staff_id,memo)
 values(p_incurred_on,'外注費',
 coalesce(inv.snapshot->'profile'->>'issuer_name','納品担当者')||' '||to_char(inv.billing_month,'YYYY年MM月')||' 請求書',
 inv.total,inv.staff_id,'納品請求書 '||inv.id::text) returning id into expense;
 insert into app.delivery_invoice_approvals(invoice_id,expense_id) values(inv.id,expense);
 return expense;
end $$;
revoke all on function app.approve_delivery_invoice(uuid,integer,date) from public,anon,authenticated;
grant execute on function app.approve_delivery_invoice(uuid,integer,date) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20260927145421_merge_waiting_into_work_in_progress.sql ▼▼▼

create or replace view app.v_stock_summary with (security_invoker=true) as
 SELECT count(DISTINCT lot_seq) AS "現在庫数",
    sum(cost_amount) AS "仕入金額合計",
    sum(COALESCE(planned_payout, 0::bigint)) AS "売上見込み合計",
    sum(COALESCE(planned_payout, 0::bigint) - cost_amount) AS "見込み利益合計",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) <= 7) AS "高回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 8 AND (CURRENT_DATE - purchased_at) <= 14) AS "中回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 15) AS "低回転",
    count(DISTINCT lot_seq) FILTER (WHERE status::text IN ('仕入済','入荷済','作業中')) AS "作業中",
    count(*) FILTER (WHERE status = '仕入済'::app.item_status) AS "入荷待ち"
   FROM app.items
  WHERE status <> ALL (ARRAY['販売済'::app.item_status, '返品処理'::app.item_status, '廃棄'::app.item_status]);
notify pgrst,'reload schema';


-- ▼▼▼ 20260927150714_private_invoice_receipts.sql ▼▼▼

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('invoice-receipts','invoice-receipts',false,20971520,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
create table app.invoice_receipts (
 id uuid primary key default gen_random_uuid(),
 staff_id uuid not null references app.delivery_invoice_profiles(staff_id),
 billing_month date not null check(extract(day from billing_month)=1),
 storage_path text not null unique,
 original_name text not null check(length(original_name) between 1 and 255),
 created_at timestamptz not null default now(),
 check(storage_path ~ ('^'||staff_id::text||'/'||to_char(billing_month,'YYYY-MM')||'/[0-9a-f-]{36}\.jpg$'))
);
create index invoice_receipts_staff_month_idx on app.invoice_receipts(staff_id,billing_month,created_at);
alter table app.invoice_receipts enable row level security;
revoke all on app.invoice_receipts from public,anon,authenticated;
grant select,delete on app.invoice_receipts to authenticated;
grant insert(staff_id,billing_month,storage_path,original_name) on app.invoice_receipts to authenticated;
create function app.can_access_invoice_receipt(p_path text,p_write boolean default false)
returns boolean language sql stable security invoker set search_path=pg_catalog,app as $$
 select auth.uid() is not null
 and (split_part(p_path,'/',1)=app.current_staff_id()::text or app.is_admin())
 and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.delivery_invoice_profiles p where p.staff_id::text=split_part(p_path,'/',1))
 and split_part(p_path,'/',2) ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 and (not p_write or not exists(
 select 1 from app.delivery_invoices i join app.delivery_invoice_approvals a on a.invoice_id=i.id
 where i.staff_id::text=split_part(p_path,'/',1) and to_char(i.billing_month,'YYYY-MM')=split_part(p_path,'/',2)
 ));
$$;
revoke all on function app.can_access_invoice_receipt(text,boolean) from public,anon,authenticated;
grant execute on function app.can_access_invoice_receipt(text,boolean) to authenticated;
create policy invoice_receipts_read on app.invoice_receipts for select to authenticated using(app.can_access_invoice_receipt(storage_path,false));
create policy invoice_receipts_insert on app.invoice_receipts for insert to authenticated with check(app.can_access_invoice_receipt(storage_path,true));
create policy invoice_receipts_delete on app.invoice_receipts for delete to authenticated using(app.can_access_invoice_receipt(storage_path,true));
create policy invoice_receipt_objects_read on storage.objects for select to authenticated
 using(bucket_id='invoice-receipts' and app.can_access_invoice_receipt(name,false));
create policy invoice_receipt_objects_insert on storage.objects for insert to authenticated
 with check(bucket_id='invoice-receipts' and app.can_access_invoice_receipt(name,true));
-- Uploaded image objects are immutable. Removing an attachment only removes its metadata.
create function app.lock_invoice_receipt_changes() returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare who uuid; target date; invoice uuid;
begin
 if tg_op='DELETE' then who:=old.staff_id; target:=old.billing_month; else who:=new.staff_id; target:=new.billing_month; end if;
 select id into invoice from app.delivery_invoices where staff_id=who and billing_month=target for update;
 if invoice is not null and exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice) then
  raise exception '承認済み請求書の領収書は変更できません';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function app.lock_invoice_receipt_changes() from public,anon,authenticated;
create trigger lock_invoice_receipt_changes before insert or delete on app.invoice_receipts for each row execute function app.lock_invoice_receipt_changes();
notify pgrst,'reload schema';


-- ▼▼▼ 20260927151227_invoice_receipt_submissions.sql ▼▼▼


create table app.invoice_receipt_submissions (
 staff_id uuid not null references app.delivery_invoice_profiles(staff_id),
 billing_month date not null check(extract(day from billing_month)=1),
 files jsonb not null,
 version integer not null default 1,
 submitted_at timestamptz not null default now(),
 primary key(staff_id,billing_month)
);
alter table app.invoice_receipt_submissions enable row level security;
revoke all on app.invoice_receipt_submissions from public,anon,authenticated;
grant select on app.invoice_receipt_submissions to authenticated;
grant insert(staff_id,billing_month) on app.invoice_receipt_submissions to authenticated;
grant update(submitted_at) on app.invoice_receipt_submissions to authenticated;
create policy receipt_submissions_read on app.invoice_receipt_submissions for select to authenticated
 using((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active));
create policy receipt_submissions_insert on app.invoice_receipt_submissions for insert to authenticated
 with check((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active));
create policy receipt_submissions_update on app.invoice_receipt_submissions for update to authenticated
 using((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active))
 with check((staff_id=app.current_staff_id() or app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active));
create trigger a_lock_receipt_submission before insert or update on app.invoice_receipt_submissions for each row execute function app.lock_invoice_receipt_changes();
create function app.fill_receipt_submission() returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'storage_path',storage_path,'original_name',original_name) order by created_at,id),'[]'::jsonb)
 into new.files from app.invoice_receipts where staff_id=new.staff_id and billing_month=new.billing_month;
 if jsonb_array_length(new.files)=0 then raise exception '領収書の画像を追加してください'; end if;
 new.submitted_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_receipt_submission() from public,anon,authenticated;
create trigger fill_receipt_submission before insert or update on app.invoice_receipt_submissions for each row execute function app.fill_receipt_submission();

create function app.submit_invoice_documents(p_staff uuid,p_month date,p_invoice boolean,p_receipts boolean,p_issued date,p_extras jsonb,p_note text,p_version integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; receipt_version integer;
begin
 if auth.uid() is null or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false)
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '送信する権限がありません' using errcode='42501'; end if;
 if not coalesce(p_invoice,false) and not coalesce(p_receipts,false) then raise exception '送信する書類を選択してください'; end if;
 -- Serialize invoice and receipt-only submissions for this staff/month.
 perform pg_advisory_xact_lock(hashtextextended(p_staff::text||p_month::text,0));
 if p_invoice then
  select * into inv from app.delivery_invoices where staff_id=p_staff and billing_month=p_month for update;
  if found then
   if p_version is null or inv.version<>p_version then raise exception '請求書が更新されています。再読み込みしてください'; end if;
   update app.delivery_invoices set issued_on=p_issued,extras=p_extras,note=p_note where id=inv.id returning * into inv;
  else
   if p_version is not null then raise exception '請求書を再読み込みしてください'; end if;
   insert into app.delivery_invoices(staff_id,billing_month,issued_on,extras,note) values(p_staff,p_month,p_issued,p_extras,p_note) returning * into inv;
  end if;
 end if;
 if p_receipts then
  insert into app.invoice_receipt_submissions(staff_id,billing_month) values(p_staff,p_month)
  on conflict(staff_id,billing_month) do update set submitted_at=clock_timestamp()
  returning version into receipt_version;
 end if;
 return jsonb_build_object('invoice',case when p_invoice then to_jsonb(inv) else null end,'receipt_version',receipt_version);
end $$;
revoke all on function app.submit_invoice_documents(uuid,date,boolean,boolean,date,jsonb,text,integer) from public,anon,authenticated;
grant execute on function app.submit_invoice_documents(uuid,date,boolean,boolean,date,jsonb,text,integer) to authenticated;
notify pgrst,'reload schema';



-- ▼▼▼ 20260927151712_packed_summary_and_document_approval.sql ▼▼▼

create function app.packed_product_summary(p_staff uuid,p_month date default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false)
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 if p_month is not null and extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 with bodies as (
 select distinct on(lot_seq) id,lot_seq,purchased_at,packed_on,title,sku
 from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
 order by lot_seq,packed_on,id
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'lot_seq',lot_seq,'purchased_at',purchased_at,'packed_on',packed_on,'title',title,'sku',sku) order by packed_on desc,lot_seq desc),'[]'::jsonb)
 into result from bodies where p_month is null or (packed_on>=p_month and packed_on<p_month+interval '1 month');
 return result;
end $$;
revoke all on function app.packed_product_summary(uuid,date) from public,anon,authenticated;
grant execute on function app.packed_product_summary(uuid,date) to authenticated;

create function app.approve_invoice_documents(p_invoice uuid,p_version integer,p_receipt_version integer,p_incurred_on date)
returns uuid language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; actual integer; result uuid;
begin
 if not coalesce(app.is_admin(),false) or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '承認する権限がありません' using errcode='42501'; end if;
 select * into inv from app.delivery_invoices where id=p_invoice;
 if not found then raise exception '請求書が見つかりません'; end if;
 perform pg_advisory_xact_lock(hashtextextended(inv.staff_id::text||inv.billing_month::text,0));
 select version into actual from app.invoice_receipt_submissions where staff_id=inv.staff_id and billing_month=inv.billing_month;
 if actual is distinct from p_receipt_version then raise exception '領収書が再提出されています。タスクを開き直してください'; end if;
 select app.approve_delivery_invoice(p_invoice,p_version,p_incurred_on) into result;
 return result;
end $$;
revoke all on function app.approve_invoice_documents(uuid,integer,integer,date) from public,anon,authenticated;
grant execute on function app.approve_invoice_documents(uuid,integer,integer,date) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20260928010000_inventory_status_workflow.sql ▼▼▼

-- A purchase starts in work; shipping makes it listed. Preserve final/manual states.
alter table app.items alter column status set default '作業中';

create or replace function app.items_sync_status() returns trigger language plpgsql as $$
begin
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then return new; end if;
  if new.amazon_returned_on is not null or new.status = 'Amazon返品' then
    if new.shipped_on is null or (new.amazon_returned_on is not null and new.shipped_on <= new.amazon_returned_on) then
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$$;

drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status before insert or update of status, arrived_on, product_registered_at,
  inspected_at, cleaned_at, photo_uploaded_at, packed_on, shipped_on, listed_on, amazon_returned_on
  on app.items for each row execute function app.items_sync_status();

update app.items set status='作業中' where status in ('仕入済','入荷済');
update app.items set status='出品中' where status='出荷済';
notify pgrst, 'reload schema';


-- ▼▼▼ 20260928011000_amazon_daily_sync.sql ▼▼▼

create extension if not exists pg_net with schema extensions;

-- The scheduler reads the encrypted token from Vault. The function only receives
-- its SHA-256 fingerprint, and browser users have no access to either record.
create table app.amazon_cron_auth (
  id boolean primary key default true check (id),
  token_hash bytea not null
);
alter table app.amazon_cron_auth enable row level security;
revoke all on app.amazon_cron_auth from public, anon, authenticated;
grant select on app.amazon_cron_auth to service_role;

do $$
declare token text := encode(gen_random_bytes(32), 'hex');
begin
  perform vault.create_secret(token, 'amazon_daily_sync_token');
  insert into app.amazon_cron_auth(id,token_hash) values(true,sha256(convert_to(token,'UTF8')));
end;
$$;

create function app.verify_amazon_cron_token(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_token is not null and length(p_token)=64 and exists (
    select 1 from app.amazon_cron_auth where id=true and token_hash=sha256(convert_to(p_token,'UTF8'))
  );
$$;
revoke all on function app.verify_amazon_cron_token(text) from public, anon, authenticated;
grant execute on function app.verify_amazon_cron_token(text) to service_role;

-- pg_cron uses UTC; 16:00 UTC is 01:00 the following day in Japan.
select cron.schedule('amazon-daily-inventory-sync', '0 16 * * *', $job$
  select net.http_post(
    url := 'https://xgoppuqoqeppckyunnvx.supabase.co/functions/v1/amazon-payments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-amazon-cron-token', (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token')
    ),
    body := '{"action":"daily"}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
notify pgrst, 'reload schema';


-- ▼▼▼ 20260928012000_preserve_amazon_return_status.sql ▼▼▼

create or replace function app.items_sync_status() returns trigger language plpgsql as $$
begin
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then return new; end if;
  if new.status='Amazon返品' or new.amazon_returned_on is not null then
    -- Keep the return until a genuinely new shipping date is entered.
    if tg_op='INSERT' or new.shipped_on is null
       or new.shipped_on is not distinct from old.shipped_on
       or (new.amazon_returned_on is not null and new.shipped_on <= new.amazon_returned_on) then
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$$;


-- ▼▼▼ 20260928013000_inventory_status_function_search_path.sql ▼▼▼

alter function app.items_sync_status() set search_path = pg_catalog, app;


-- ▼▼▼ 20260928095147_four_delivery_steps_with_editable_dates.sql ▼▼▼

create function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;
revoke all on function app.set_delivery_progress(uuid,text,boolean,date) from public,anon,authenticated;
grant execute on function app.set_delivery_progress(uuid,text,boolean,date) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20260929000000_amazon_order_report_history.sql ▼▼▼

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


-- ▼▼▼ 20260929001000_amazon_unmatched_app_sales.sql ▼▼▼

create or replace view app.v_amazon_unmatched_app_sales with (security_invoker=true) as
with amazon_lots as (
  select distinct case
    when canonical_sku ~ '^[0-9]+-' then split_part(canonical_sku,'-',1)::integer
    when canonical_sku ~ '^[0-9]+$' then canonical_sku::integer
    else null end as lot_seq
  from app.v_amazon_order_reconciliation
  where order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and item_price is not null
), sold_products as (
  select lot_seq, min(sold_on) as app_sold_on, max(sold_price) as app_sold_price,
    min(sku) as example_sku, string_agg(distinct sales_channel::text, ', ') as sales_channels,
    count(*) as app_row_count
  from app.items
  where sold_on is not null and sales_channel::text in ('FBA','自己発送') and is_accessory=false
  group by lot_seq
)
select s.* from sold_products s where not exists (select 1 from amazon_lots a where a.lot_seq=s.lot_seq);
grant select on app.v_amazon_unmatched_app_sales to authenticated;


-- ▼▼▼ 20260929090000_inventory_display_fields.sql ▼▼▼

-- Keep the two refund sources visible without changing the existing profit formula.
alter table app.items
  add column if not exists amazon_refund_amount bigint not null default 0 check (amazon_refund_amount >= 0),
  add column if not exists non_amazon_refund_amount bigint not null default 0 check (non_amazon_refund_amount >= 0);

update app.items
set amazon_refund_amount = case when refund_note ilike '%Amazon%' then refund_amount else 0 end,
    non_amazon_refund_amount = case when refund_note ilike '%Amazon%' then 0 else refund_amount end
where refund_amount > 0
  and amazon_refund_amount = 0 and non_amazon_refund_amount = 0;

create or replace function app.sync_refund_sources() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.refund_amount > 0 and new.amazon_refund_amount = 0 and new.non_amazon_refund_amount = 0 then
      if new.refund_note ilike '%Amazon%' then new.amazon_refund_amount := new.refund_amount;
      else new.non_amazon_refund_amount := new.refund_amount; end if;
    else
      new.refund_amount := new.amazon_refund_amount + new.non_amazon_refund_amount;
    end if;
  elsif new.amazon_refund_amount is distinct from old.amazon_refund_amount
     or new.non_amazon_refund_amount is distinct from old.non_amazon_refund_amount then
    new.refund_amount := new.amazon_refund_amount + new.non_amazon_refund_amount;
  elsif new.refund_amount is distinct from old.refund_amount then
    if new.refund_note ilike '%Amazon%' then
      new.amazon_refund_amount := new.refund_amount;
      new.non_amazon_refund_amount := 0;
    else
      new.amazon_refund_amount := 0;
      new.non_amazon_refund_amount := new.refund_amount;
    end if;
  end if;
  return new;
end; $$;
revoke all on function app.sync_refund_sources() from public, anon, authenticated;
drop trigger if exists items_sync_refund_sources on app.items;
create trigger items_sync_refund_sources before insert or update of refund_amount, amazon_refund_amount, non_amazon_refund_amount
on app.items for each row execute function app.sync_refund_sources();

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*,
  raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount,
  latest.body as latest_comment
from app.v_inventory_items inventory
join app.items raw on raw.id = inventory.id
left join app.products product on product.id = raw.product_id
left join lateral (
  select body from app.item_comments
  where item_id = inventory.id
  order by created_at desc, id desc limit 1
) latest on true;
grant select on app.v_inventory_display to authenticated;


-- ▼▼▼ 20260929091000_inventory_product_profit.sql ▼▼▼

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*,
  raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount,
  latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds - inventory.product_cost
      - totals.shipping - totals.other_cost
  end as product_profit
from app.v_inventory_items inventory
join app.items raw on raw.id = inventory.id
left join app.products product on product.id = raw.product_id
left join lateral (
  select body from app.item_comments
  where item_id = inventory.id
  order by created_at desc, id desc limit 1
) latest on true
left join lateral (
  select sum(refund_amount) as refunds, sum(shipping_cost) as shipping,
    sum(other_cost) as other_cost
  from app.items where lot_seq = inventory.lot_seq
) totals on true;
grant select on app.v_inventory_display to authenticated;


-- ▼▼▼ 20260929135000_reship_amazon_return.sql ▼▼▼

-- A completed shipping step after an Amazon return must record a new date.
-- Keeping the old date leaves the item permanently marked as returned.
create or replace function app.set_work_progress(p_item_id uuid, p_step text, p_done boolean default true)
returns app.items language plpgsql security definer set search_path = app, public as $$
declare v_item app.items;
begin
  if p_step is null or p_done is null or p_step not in ('arrived','registered','inspected','cleaned','photo','listing','packed','shipped') then
    raise exception '不明な作業ステップです' using errcode = '22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  update app.items set
    arrived_on = case when p_step = 'arrived' then case when p_done then coalesce(arrived_on,current_date) else null end
      when p_done then coalesce(arrived_on,current_date) else arrived_on end,
    product_registered_at = case when p_step in ('registered','listing') then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
    inspected_at = case when p_step = 'inspected' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
    cleaned_at = case when p_step = 'cleaned' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
    photo_uploaded_at = case when p_step in ('photo','listing') then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
    packed_on = case when p_step = 'packed' then case when p_done then coalesce(packed_on,current_date) else null end else packed_on end,
    shipped_on = case when p_step = 'shipped' then case when p_done then
      case when (amazon_returned_on is not null and shipped_on <= amazon_returned_on)
             or (amazon_returned_on is null and status = 'Amazon返品')
        then current_date else coalesce(shipped_on,current_date) end
      else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end;
$$;


-- ▼▼▼ 20260929160000_purchase_marketplaces.sql ▼▼▼

alter type app.marketplace add value if not exists 'Amazon';
alter type app.marketplace add value if not exists 'Yahoo！ショッピング';


-- ▼▼▼ 20260929190000_amazon_fee_expense_reconciliation.sql ▼▼▼

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


-- ▼▼▼ 20260929191000_inventory_edit_sku_and_lot.sql ▼▼▼

create or replace function app.update_item_identity(p_item_id uuid,p_expected_updated_at timestamptz,p_field text,p_value text)
returns void language plpgsql security invoker set search_path = pg_catalog, app, public as $$
declare current_item app.items%rowtype; next_lot integer; next_sku text;
begin
 if app.current_role() not in ('admin','purchaser') then raise exception '編集権限がありません'; end if;
 select * into current_item from app.items where id=p_item_id for update;
 if not found then raise exception '在庫が見つかりません'; end if;
 if current_item.updated_at is distinct from p_expected_updated_at then raise exception '在庫が別の画面で変更されています'; end if;
 if p_field='lot_seq' then
   if p_value !~ '^[1-9][0-9]*$' then raise exception '通番号は1以上の整数で入力してください'; end if;
   next_lot:=p_value::integer;
   next_sku:=regexp_replace(current_item.sku,'^[0-9]+',next_lot::text);
   insert into app.lots(seq) values(next_lot) on conflict(seq) do nothing;
 elsif p_field='sku' then
   if p_value !~ '^[0-9]+[a-z]*-[A-Z]{2,4}-[0-9]{8}-[0-9]+$' then raise exception 'SKUの形式を確認してください'; end if;
   if substring(p_value from '^[0-9]+')::integer<>current_item.lot_seq then raise exception 'SKUの先頭と通番号を一致させてください'; end if;
   next_lot:=current_item.lot_seq;
   next_sku:=p_value;
 else
   raise exception '編集項目が不正です';
 end if;
 update app.items set lot_seq=next_lot,sku=next_sku where id=p_item_id;
end $$;
revoke all on function app.update_item_identity(uuid,timestamptz,text,text) from public;
grant execute on function app.update_item_identity(uuid,timestamptz,text,text) to authenticated;
comment on column app.items.sku is '出品者SKU。編集時は通番号と先頭番号を一致させる。';


-- ▼▼▼ 20260929193000_photo_review_and_spares.sql ▼▼▼

-- Uploaded photographs stay separate from the Amazon catalogue image.
-- A successful Drive export creates a review task; packing and shipping require approval.
alter table app.item_photos add column drive_file_id text;
create table app.photo_reviews (
  item_id uuid primary key references app.items(id) on delete cascade,
  drive_folder_id text not null,
  exported_photo_count integer not null check (exported_photo_count > 0),
  submitted_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references app.staff(id),
  updated_at timestamptz not null default now()
);
create index photo_reviews_pending_idx on app.photo_reviews(submitted_at) where approved_at is null;
alter table app.photo_reviews enable row level security;
grant select on app.photo_reviews to authenticated;
grant all on app.photo_reviews to service_role;
grant select on app.profiles, app.staff, app.items to service_role;
grant select, update on app.item_photos to service_role;
create policy photo_reviews_read on app.photo_reviews for select to authenticated using (
  app.is_admin() or exists (
    select 1 from app.items i where i.id = item_id and i.deliverer_id = app.current_staff_id()
  )
);

-- Enable the gate only after Google OAuth has been connected and the new UI is live.
create table app.photo_review_settings (
  id boolean primary key default true check (id),
  enforced boolean not null default false
);
insert into app.photo_review_settings(id,enforced) values(true,false);
alter table app.photo_review_settings enable row level security;
grant select on app.photo_review_settings to authenticated;
grant select, update on app.photo_review_settings to service_role;
create policy photo_review_settings_read on app.photo_review_settings for select to authenticated using (true);

create function app.photo_review_enforced() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enforced from app.photo_review_settings where id=true),false);
$$;
revoke all on function app.photo_review_enforced() from public,anon;
grant execute on function app.photo_review_enforced() to authenticated;

create function app.approve_photo_review(p_item_id uuid)
returns app.photo_reviews language plpgsql security definer set search_path = '' as $$
declare v_result app.photo_reviews; v_count integer;
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '写真確認の権限がありません' using errcode = '42501';
  end if;
  select count(*) into v_count from app.item_photos where item_id = p_item_id;
  update app.photo_reviews
     set approved_at = now(), approved_by = app.current_staff_id(), updated_at = now()
   where item_id = p_item_id and approved_at is null and exported_photo_count = v_count
   returning * into v_result;
  if not found then
    raise exception '未送信の写真があるか、確認済みです。Googleドライブに追加し直してください。' using errcode = '22023';
  end if;
  return v_result;
end $$;
revoke all on function app.approve_photo_review(uuid) from public, anon;
grant execute on function app.approve_photo_review(uuid) to authenticated;

create function app.invalidate_photo_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update app.photo_reviews set approved_at = null, approved_by = null, updated_at = now()
    where item_id = new.item_id;
  return new;
end $$;
create trigger item_photos_invalidate_review after insert on app.item_photos
  for each row execute function app.invalidate_photo_review();

create or replace function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 if p_done and p_step in ('packed','shipped') and app.photo_review_enforced() and not exists (
   select 1 from app.photo_reviews r where r.item_id = p_item_id and r.approved_at is not null
 ) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;

-- Legacy RPC is still callable: enforce the same check there.
create or replace function app.require_photo_review(p_item_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if app.photo_review_enforced() and not exists (select 1 from app.photo_reviews where item_id=p_item_id and approved_at is not null) then
    raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
  end if;
end $$;
revoke all on function app.require_photo_review(uuid) from public, anon, authenticated;

create or replace function app.set_work_progress(p_item_id uuid, p_step text, p_done boolean default true)
returns app.items language plpgsql security definer set search_path = '' as $$
declare v_item app.items;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  if p_step not in ('arrived','registered','inspected','photo','packed','shipped') then
    raise exception '作業項目を確認してください' using errcode='22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  if p_done and p_step in ('packed','shipped') then perform app.require_photo_review(p_item_id); end if;
  update app.items set
    arrived_on = case when p_step='arrived' then case when p_done then current_date else null end else arrived_on end,
    product_registered_at = case when p_step='registered' then case when p_done then now() else null end else product_registered_at end,
    inspected_at = case when p_step='inspected' then case when p_done then now() else null end else inspected_at end,
    photo_uploaded_at = case when p_step='photo' then case when p_done then now() else null end else photo_uploaded_at end,
    packed_on = case when p_step='packed' then case when p_done then current_date else null end else packed_on end,
    shipped_on = case when p_step='shipped' then case when p_done then current_date else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end $$;

-- Reserve accessories are a separate ledger. They are not ordinary saleable stock.
create table app.spare_accessories (
  id uuid primary key default gen_random_uuid(),
  source_sheet_row integer unique,
  source_sku text,
  owner_staff_id uuid references app.staff(id),
  owner_name text,
  purchased_at date,
  title text not null,
  cost_amount bigint not null default 0 check (cost_amount >= 0),
  marketplace text,
  marketplace_item_id text,
  tracking_no text,
  usage_note text,
  linked_item_id uuid references app.items(id),
  used_for_item_id uuid references app.items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index spare_accessories_owner_idx on app.spare_accessories(owner_staff_id);
alter table app.spare_accessories enable row level security;
grant select on app.spare_accessories to authenticated;
create policy spare_accessories_read on app.spare_accessories for select to authenticated using (
  app.is_admin() or owner_staff_id = app.current_staff_id()
);

create function app.allocate_spare_accessory(p_spare_id uuid, p_item_id uuid)
returns app.spare_accessories language plpgsql security definer set search_path = '' as $$
declare v_result app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備を割り当てる権限がありません' using errcode='42501';
  end if;
  if not exists (select 1 from app.items where id=p_item_id) then
    raise exception '割り当て先の商品が見つかりません' using errcode='22023';
  end if;
  update app.spare_accessories set used_for_item_id=p_item_id, updated_at=now()
    where id=p_spare_id and used_for_item_id is null and usage_note is null
      and (app.is_admin() or owner_staff_id=app.current_staff_id())
    returning * into v_result;
  if not found then raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023'; end if;
  return v_result;
end $$;
revoke all on function app.allocate_spare_accessory(uuid,uuid) from public, anon;
grant execute on function app.allocate_spare_accessory(uuid,uuid) to authenticated;


-- Snapshot of the reserve section of 仕入れ販売管理 (rows 3323-3344).
-- Sheet notes containing delivery addresses are deliberately excluded.
with source(source_sheet_row,source_sku,owner_name,purchased_at,title,cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note) as (
 values
 (3323,'2b-AAEE-20260502-175','石川秀樹','2026-05-02','リモコン',1758,'ヤフオク','c1228042044','ヤマト646340135545',null),
 (3324,'3b-AAEE-20260502-145','石川秀樹','2026-05-02','リモコン',1457,'ヤフオク','q1228038391','ヤマト646340135545',null),
 (3325,'4b-AAEE-20260502-175','石川秀樹','2026-05-02','リモコン',1757,'ヤフオク','t1223962133','ヤマト646340135545',null),
 (3326,null,'株式会社吉光','2026-09-16','リモコン',0,'ヤフオク','1243959352','ヤマト623211133462','2344リモコン'),
 (3327,null,'久保田真由','2026-06-15','リモコン蓋',740,'その他','250-2416044-2821427','郵便628698508491',null),
 (3329,null,null,'2026-05-05','リモコン',2000,'メルカリ','m93183062306','郵便628790320642',null),
 (3330,null,'久保田真由','2026-07-08','リモコン',0,'ヤフオク','n1235408948','郵便628689522565','1933リモコン'),
 (3331,null,'石川秀樹','2026-05-05','リモコン',0,'ヤフフリ','z604043190','ヤマト623275478383','1528aリモコン'),
 (3332,null,'石川秀樹','2026-05-24','リモコン',3685,'ヤフオク','g1226658491','郵便628617746422','1576aリモコン'),
 (3333,null,'石川秀樹','2026-06-08','リモコン',8300,'ヤフオク','j1228041764','佐川444076880822','1738リモコン / 1755aリモコン'),
 (3334,null,'石川秀樹','2026-05-24','リモコン',10352,'ヤフオク','e1230589619','ヤマト3900-5055-3874','1630aリモコン'),
 (3335,null,'石川秀樹','2026-03-27','リモコン',2000,'メルカリ','m78850698210','郵便647304009321','1270aリモコン'),
 (3336,null,'石川秀樹','2026-05-18','リモコン',1680,'メルカリ','m68137917077','ヤマト626701515366','1580aリモコン'),
 (3337,null,'石川秀樹','2026-07-01','リモコン',0,'ヤフオク','j1234015690','ヤマト623190642115','1892aリモコン'),
 (3338,null,'石川秀樹','2026-05-30','リモコン',0,'メルカリ','m81833007306','郵便628651336972','1764aリモコン'),
 (3339,null,'石川秀樹','2026-05-23','リモコン',2000,'メルカリ','m37332601503','郵便628623312601','1649aリモコン'),
 (3340,null,'石川秀樹','2026-05-26','リモコン',1500,'メルカリ','m10177010792','ヤマト623109541283','1647リモコン / 1723リモコン / 1765aリモコン'),
 (3341,null,'石川秀樹','2026-07-09','リモコン',2000,'メルカリ','m74152529713','郵便647676016525','1942aリモコン'),
 (3342,null,'土井花菜','2026-09-18','リモコン',1830,'ヤフオク','b1244958717','郵便646846907803','2353リモコン / 2378リモコン'),
 (3343,null,null,'2026-09-08','リモコン',950,'メルカリ','m48999368969','',null),
 (3344,null,'土井花菜','2026-09-12','リモコン',998,'ヤフオク','f1234127932','定形外郵便','2316リモコン')
)
insert into app.spare_accessories(source_sheet_row,source_sku,owner_name,owner_staff_id,purchased_at,title,cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note,linked_item_id)
select s.source_sheet_row,s.source_sku,s.owner_name,st.id,s.purchased_at::date,s.title,s.cost_amount,s.marketplace,s.marketplace_item_id,s.tracking_no,s.usage_note,i.id
from source s
left join app.staff st on st.name=s.owner_name and st.is_active
left join app.items i on i.sku=s.source_sku
on conflict (source_sheet_row) do nothing;

notify pgrst, 'reload schema';


-- ▼▼▼ 20260929194000_auto_sku_on_identity_change.sql ▼▼▼

-- Keep historical SKUs usable for scans, photographs and Amazon order matching.
create table app.item_sku_aliases (
  sku text primary key,
  item_id uuid not null references app.items(id) on delete cascade,
  changed_at timestamptz not null default now()
);
create index item_sku_aliases_item_idx on app.item_sku_aliases(item_id);
alter table app.item_sku_aliases enable row level security;
grant select on app.item_sku_aliases to authenticated;
create policy item_sku_aliases_read on app.item_sku_aliases for select to authenticated using (
  exists (select 1 from app.items i where i.id=item_id
    and (app.current_role() in ('admin','purchaser') or i.deliverer_id=app.current_staff_id()))
);

create function app.sync_sku_from_item_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare purchaser_code text; deliverer_code text; middle_code text; date_part text; suffix text;
begin
  if new.lot_seq is distinct from old.lot_seq
      or new.purchaser_id is distinct from old.purchaser_id
      or new.deliverer_id is distinct from old.deliverer_id
      or new.purchased_at is distinct from old.purchased_at
      or new.cost_amount is distinct from old.cost_amount then
    select code into purchaser_code from app.staff where id=new.purchaser_id;
    select code into deliverer_code from app.staff where id=new.deliverer_id;
    middle_code := coalesce(purchaser_code,'') || coalesce(deliverer_code,'');
    if middle_code='' then middle_code:=split_part(old.sku,'-',2); end if;
    if length(middle_code) not in (2,4) then raise exception '担当者コードを確認してください' using errcode='22023'; end if;
    date_part := case when new.purchased_at is null then split_part(old.sku,'-',3)
                      else to_char(new.purchased_at,'YYYYMMDD') end;
    suffix := coalesce(substring(new.sku from '^[0-9]+([a-z]+)-'),
                       substring(old.sku from '^[0-9]+([a-z]+)-'), '');
    new.sku := new.lot_seq::text || suffix || '-' || middle_code || '-' || date_part || '-' || (new.cost_amount / 10)::bigint;
  end if;
  if exists (select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then
    raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';
  end if;
  return new;
end $$;
create trigger items_sync_sku_from_identity before update of lot_seq,purchaser_id,deliverer_id,purchased_at,cost_amount,sku
  on app.items for each row execute function app.sync_sku_from_item_identity();

create function app.record_item_sku_alias() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.sku is distinct from old.sku then
    insert into app.item_sku_aliases(sku,item_id) values(old.sku,new.id)
      on conflict (sku) do update set item_id=excluded.item_id,changed_at=now()
      where app.item_sku_aliases.item_id=excluded.item_id;
  end if;
  return new;
end $$;
create trigger items_record_sku_alias after update of sku on app.items
  for each row execute function app.record_item_sku_alias();

create or replace function app.find_by_sku(p_sku text) returns app.items
language sql stable security definer set search_path = '' as $$
  select i.* from app.items i
  where (i.sku=btrim(p_sku) or exists (select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=btrim(p_sku)))
    and (app.is_admin() or i.deliverer_id=app.current_staff_id())
  limit 1;
$$;

drop policy if exists "item photos are readable by staff in charge" on storage.objects;
create policy "item photos are readable by staff in charge" on storage.objects for select to authenticated
using (bucket_id='item-photos' and exists (
  select 1 from app.items i where
    (i.sku=split_part(name,'/',1) or exists (select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=split_part(name,'/',1)))
    and (app.current_role() in ('admin','purchaser') or i.deliverer_id=app.current_staff_id())
));

-- Original catalogue numbers remain on app.products; v_inventory_display joins them by product_id.
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
), sku_links as (
  select sku,id as item_id from app.items
  union
  select sku,item_id from app.item_sku_aliases
), items_by_sku as (
  select l.sku, max(i.sold_on) as app_sold_on, max(i.sold_price) as app_sold_price,
    count(*) as app_row_count
  from sku_links l join app.items i on i.id=l.item_id group by l.sku
), matched as (
  select n.*, i.app_sold_on, i.app_sold_price, i.app_row_count,
    count(*) filter (where n.order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and n.item_price is not null)
      over (partition by n.account_key,n.canonical_sku) as order_count_for_sku
  from normalized n left join items_by_sku i on i.sku=n.canonical_sku
)
select account_key,order_item_id,order_id,ordered_at,order_on,order_status,fulfillment_channel,
  sku,canonical_sku,asin,quantity,currency,item_price,item_tax,shipping_price,shipping_tax,
  promotion_discount,source_report,imported_at,app_sold_on,app_sold_price,app_row_count,
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

notify pgrst, 'reload schema';


-- ▼▼▼ 20261001032627_item_photo_delete_cleanup.sql ▼▼▼

-- Removing any uploaded photo invalidates the previous Drive review submission.
-- The last photo also clears the delivery workflow's photo-complete timestamp.
create or replace function app.handle_deleted_item_photo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_count integer;
begin
  delete from app.photo_reviews where item_id = old.item_id;
  select count(*) into remaining_count from app.item_photos where item_id = old.item_id;
  if remaining_count = 0 then
    update app.items set photo_uploaded_at = null where id = old.item_id;
  end if;
  return old;
end;
$$;

revoke all on function app.handle_deleted_item_photo() from public, anon, authenticated;
drop trigger if exists item_photos_cleanup_after_delete on app.item_photos;
create trigger item_photos_cleanup_after_delete
  after delete on app.item_photos
  for each row execute function app.handle_deleted_item_photo();


-- ▼▼▼ 20261001040000_delivery_tasks_marketplace_item_id.sql ▼▼▼

create or replace view app.v_delivery_tasks with (security_invoker = true) as
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
  (i.inspected_at is not null) as inspected,
  (i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,
  i.shipped_on,
  i.amazon_returned_on,
  p.image_url as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id = i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id = i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,
  i.description_template,
  i.manufacture_year,
  i.marketplace_item_id
from app.items i
left join app.products p on p.id = i.product_id
left join app.staff buyer on buyer.id = i.purchaser_id
where i.status in ('仕入済', '入荷済', '作業中', 'Amazon返品', '出荷済', '出品中', '販売済');

notify pgrst, 'reload schema';


-- ▼▼▼ 20261001172026_manage_spare_accessories.sql ▼▼▼

-- Let administrators manage the shared spare ledger, and purchasers manage only their own spares.
grant insert, update on app.spare_accessories to authenticated;

create policy spare_accessories_insert on app.spare_accessories
  for insert to authenticated
  with check (
    app.is_admin()
    or (app.current_role() = 'purchaser' and owner_staff_id = app.current_staff_id())
  );

create policy spare_accessories_update on app.spare_accessories
  for update to authenticated
  using (
    app.is_admin()
    or (app.current_role() = 'purchaser' and owner_staff_id = app.current_staff_id())
  )
  with check (
    app.is_admin()
    or (app.current_role() = 'purchaser' and owner_staff_id = app.current_staff_id())
  );


-- ▼▼▼ 20261002010000_separate_suffix_product_identity.sql ▼▼▼

-- SKU serials such as 1977, 1977A and 1977AA identify distinct physical products.
-- Keep lot_seq as the supplier-row FK; use the complete SKU serial for product grouping.
create or replace function app.product_serial(p_sku text, p_lot_seq integer default null)
returns text language sql immutable parallel safe set search_path = '' as $$
  select coalesce(upper((regexp_match(p_sku, '^([0-9]+[a-z]*)[-_]'))[1]), p_lot_seq::text)
$$;

create or replace view app.v_product_groups with (security_invoker = true) as
with grouped as (
  select min(lot_seq) as lot_seq, app.product_serial(sku, lot_seq) as serial_key,
    count(*)::integer as product_row_count, sum(cost_amount)::bigint as product_cost,
    count(*) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))::integer as sale_row_count,
    count(distinct (sold_on,sold_price,payout_amount)) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as signatures,
    bool_or(sold_on is not null and sold_price is null and not is_accessory) as missing_price,
    min(sold_on) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_date,
    max(sold_price) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_price,
    max(payout_amount) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_payout
  from app.items group by app.product_serial(sku, lot_seq)
)
select lot_seq,product_row_count,product_cost,sale_row_count,
  (signatures > 1 or coalesce(missing_price,false)) as product_sale_conflict,
  case when signatures=1 and not coalesce(missing_price,false) then sale_date end as product_sold_on,
  case when signatures=1 and not coalesce(missing_price,false) then sale_price end as product_sold_price,
  case when signatures=1 and not coalesce(missing_price,false) then sale_payout end as product_payout_amount,
  serial_key
from grouped;
grant select on app.v_product_groups to authenticated,service_role;

create or replace view app.v_inventory_items with (security_invoker = true) as
select i.*,g.product_row_count,g.product_cost,g.sale_row_count,g.product_sale_conflict,
  g.product_sold_on,g.product_sold_price,g.product_payout_amount
from app.v_items i join app.v_product_groups g
  on g.serial_key=app.product_serial(i.sku,i.lot_seq);
grant select on app.v_inventory_items to authenticated;

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*, raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds - inventory.product_cost
      - totals.shipping - totals.other_cost end as product_profit
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join lateral (select body from app.item_comments where item_id=inventory.id order by created_at desc,id desc limit 1) latest on true
left join lateral (
  select sum(refund_amount) as refunds,sum(shipping_cost) as shipping,sum(other_cost) as other_cost
  from app.items where app.product_serial(sku,lot_seq)=app.product_serial(raw.sku,raw.lot_seq)
) totals on true;
grant select on app.v_inventory_display to authenticated;

create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path='' as $$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then return new; end if;
  serial_key := app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>new.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    raise exception '同じ商品番号の商品に販売記録があります。売上を重複登録できません。';
  end if;
  return new;
end; $$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;

create or replace function app.apply_amazon_sale(
  p_account text,p_transaction text,p_sku text,p_asin text,p_sold_on date,p_price bigint,p_payout bigint,p_actor uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_lot integer; target_count integer; serial_key text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status in ('RELEASED','DEFERRED_RELEASED');
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  select id,lot_seq into target_id,target_lot from app.items where sku=p_sku;
  serial_key:=app.product_serial(p_sku,null);
  if target_id is null and serial_key is not null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then return jsonb_build_object('status','review','reason','同じ商品番号の本体行を1件に特定できません。'); end if;
    select lot_seq into target_lot from app.items where id=target_id;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・商品番号が在庫一覧にありません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if inventory.status in ('返品処理','Amazon返品','廃棄') or inventory.amazon_returned_on is not null or inventory.returned_on is not null or (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','返品・廃棄、または仕入日より前の販売のため確認が必要です。'); end if;
  if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>inventory.id and i.sold_on is not null and not(i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>inventory.id and i.sold_on is not null and not(i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and (i.sold_on is distinct from p_sold_on or i.sold_price is distinct from p_price or i.payout_amount is distinct from p_payout)) then return jsonb_build_object('status','review','reason','同じ商品番号に異なる販売記録があります。自動上書きしません。'); end if;
    return jsonb_build_object('status','unchanged','reason','同じ商品番号に同じ販売内容を登録済みです。重複記入しません。');
  end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif (inventory.sold_on is not null and inventory.sold_on<>p_sold_on) or (inventory.sold_price is not null and inventory.sold_price<>p_price) or (inventory.payout_amount is not null and inventory.payout_amount<>p_payout) then return jsonb_build_object('status','review','reason','既存の販売記録と異なります。自動上書きしません。'); end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を反映しました。');
end; $$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;

create or replace view app.v_stock_summary with (security_invoker = true) as
select count(distinct app.product_serial(sku,lot_seq)) as "現在庫数",
  sum(cost_amount) as "仕入金額合計",sum(coalesce(planned_payout,0)) as "売上見込み合計",
  sum(coalesce(planned_payout,0)-cost_amount) as "見込み利益合計",
  count(*) filter(where current_date-purchased_at<=7) as "高回転",
  count(*) filter(where current_date-purchased_at between 8 and 14) as "中回転",
  count(*) filter(where current_date-purchased_at>=15) as "低回転",
  count(*) filter(where status='作業中'::app.item_status) as "作業中",
  count(*) filter(where status='仕入済'::app.item_status) as "入荷待ち"
from app.items where status not in ('販売済'::app.item_status,'返品処理'::app.item_status,'廃棄'::app.item_status);

create or replace view app.v_monthly_summary with (security_invoker = true) as
with purchased as (
 select date_trunc('month',purchased_at::timestamptz)::date as month,count(*) as "仕入数",sum(cost_amount) as "仕入金額",avg(cost_amount)::bigint as "平均仕入額"
 from app.items group by 1
), sold as (
 select date_trunc('month',sold_on::timestamptz)::date as month,
  count(distinct app.product_serial(sku,lot_seq)) filter(where not(is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as "販売数",
  sum(sold_price) as "売上",sum(payout_amount) as "振込金額",sum(profit) as "粗利益",avg(sold_price)::bigint as "平均販売額",
  avg(sold_on-purchased_at)::numeric(10,1) as "平均回転日数"
 from app.items where sold_on is not null group by 1
), expense as (
 select date_trunc('month',incurred_on::timestamptz)::date as month,sum(amount) as "経費" from app.expenses group by 1
)
select coalesce(p.month,s.month,e.month) as month,coalesce(p."仕入数",0::bigint) as "仕入数",
 coalesce(p."仕入金額",0::numeric) as "仕入金額",coalesce(p."平均仕入額",0::bigint) as "平均仕入額",
 coalesce(s."販売数",0::bigint) as "販売数",coalesce(s."売上",0::numeric) as "売上",coalesce(s."振込金額",0::numeric) as "振込金額",
 coalesce(s."粗利益",0::numeric) as "粗利益",coalesce(s."平均販売額",0::bigint) as "平均販売額",s."平均回転日数",
 coalesce(e."経費",0::numeric) as "経費",coalesce(s."粗利益",0::numeric)-coalesce(e."経費",0::numeric) as "純利益"
from purchased p full join sold s on s.month=p.month full join expense e on e.month=coalesce(p.month,s.month)
order by coalesce(p.month,s.month,e.month) desc;

create or replace function app.packed_product_summary(p_staff uuid,p_month date default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false)
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 if p_month is not null and extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 with bodies as (
  select distinct on(app.product_serial(sku,lot_seq)) id,lot_seq,purchased_at,packed_on,title,sku
  from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
  order by app.product_serial(sku,lot_seq),packed_on,id
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'lot_seq',lot_seq,'purchased_at',purchased_at,'packed_on',packed_on,'title',title,'sku',sku) order by packed_on desc,lot_seq desc),'[]'::jsonb)
 into result from bodies where p_month is null or (packed_on>=p_month and packed_on<p_month+interval '1 month');
 return result;
end $$;
revoke all on function app.packed_product_summary(uuid,date) from public,anon,authenticated;
grant execute on function app.packed_product_summary(uuid,date) to authenticated;

create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then raise exception '請求書へのアクセス権がありません' using errcode='42501'; end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 with bodies as (
  select distinct on(app.product_serial(sku,lot_seq)) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,sku
  from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
  order by app.product_serial(sku,lot_seq),packed_on,id
 ), selected as (select * from bodies where packed_on>=p_month and packed_on<p_month+interval '1 month')
 select coalesce(jsonb_agg(jsonb_build_object('item_id',id,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
  'description',case when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
   when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
  'title',title,'quantity',1,'unit_price',p.unit_price,'amount',p.unit_price) order by purchased_at nulls last,lot_seq),'[]'::jsonb),count(*)*p.unit_price
 into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

create or replace view app.v_amazon_unmatched_app_sales with (security_invoker=true) as
with amazon_serials as (
 select distinct app.product_serial(canonical_sku,null) as serial_key
 from app.v_amazon_order_reconciliation
 where order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and item_price is not null
), sold_products as (
 select min(lot_seq) as lot_seq,app.product_serial(sku,lot_seq) as serial_key,min(sold_on) as app_sold_on,max(sold_price) as app_sold_price,
  min(sku) as example_sku,string_agg(distinct sales_channel::text,', ') as sales_channels,count(*) as app_row_count
 from app.items where sold_on is not null and sales_channel::text in ('FBA','自己発送') and is_accessory=false
 group by app.product_serial(sku,lot_seq)
)
select s.lot_seq,s.app_sold_on,s.app_sold_price,s.example_sku,s.sales_channels,s.app_row_count
from sold_products s where not exists(select 1 from amazon_serials a where a.serial_key=s.serial_key);
grant select on app.v_amazon_unmatched_app_sales to authenticated;

notify pgrst,'reload schema';


-- ▼▼▼ 20261002113100_allow_spares_with_usage_notes.sql ▼▼▼

-- Usage notes describe historical allocation attempts, not whether a spare is available.
create or replace function app.allocate_spare_accessory(p_spare_id uuid, p_item_id uuid)
returns app.spare_accessories language plpgsql security definer set search_path = '' as $$
declare v_result app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備を割り当てる権限がありません' using errcode='42501';
  end if;
  if not exists (select 1 from app.items where id=p_item_id) then
    raise exception '割り当て先の商品が見つかりません' using errcode='22023';
  end if;
  update app.spare_accessories set used_for_item_id=p_item_id, updated_at=now()
    where id=p_spare_id and used_for_item_id is null
      and (app.is_admin() or owner_staff_id=app.current_staff_id())
    returning * into v_result;
  if not found then raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023'; end if;
  return v_result;
end $$;


-- ▼▼▼ 20261002114309_enforce_amazon_returns_as_main_items.sql ▼▼▼

-- Amazon return rows represent returned main products, never attached accessories.
-- Fix existing classifications first so the return SKU sequence sees every row.
update app.items
set is_accessory = false, updated_at = now()
where marketplace::text = 'Amazon返品' and is_accessory
  and (status::text = 'Amazon返品' or amazon_returned_on is not null);

-- Legacy/imported rows can contain multiple physical returns with the same serial
-- suffix (for example 2055a twice). Keep the oldest serial and give each later
-- collision the next suffix, preserving the rest of its SKU and its row history.
do $$
declare
  collision record;
  candidate_depth integer;
  candidate_sku text;
begin
  for collision in
    with returned_items as (
      select i.id, i.sku, i.lot_seq,
        app.product_serial(i.sku, i.lot_seq) as serial_key,
        (regexp_match(i.sku, '^([0-9]+)'))[1] as numeric_serial,
        length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], '')) as suffix_depth,
        i.created_at, i.amazon_returned_on, i.returned_on
      from app.items i
      where i.marketplace::text = 'Amazon返品'
        and (i.status::text = 'Amazon返品' or i.amazon_returned_on is not null)
    ), ranked_collisions as (
      select r.*,
        row_number() over(partition by r.lot_seq, r.serial_key order by r.created_at, r.amazon_returned_on nulls last, r.returned_on nulls last, r.id) as sequence_no,
        count(*) over(partition by r.lot_seq, r.serial_key) as collision_count
      from returned_items r
    )
    select * from ranked_collisions where collision_count > 1 and sequence_no > 1
    order by lot_seq, numeric_serial, sequence_no
  loop
    candidate_depth := greatest(collision.suffix_depth + 1, 1);
    loop
      candidate_sku := collision.numeric_serial || repeat('a', candidate_depth)
        || substring(collision.sku from '^[0-9]+[a-z]*([-_].*)$');
      exit when not exists (
        select 1 from app.items other
        where other.id <> collision.id and not other.is_accessory
          and app.product_serial(other.sku, other.lot_seq)
            = collision.numeric_serial || repeat('a', candidate_depth)
      );
      candidate_depth := candidate_depth + 1;
    end loop;
    update app.items set sku = candidate_sku, updated_at = now() where id = collision.id;
  end loop;
end;
$$;

create or replace function app.enforce_amazon_return_main_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  numeric_serial text;
  separator_and_tail text;
  requested_depth integer;
  existing_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then
    return new;
  end if;

  if tg_op <> 'INSERT' then
    if new.status::text = 'Amazon返品' or new.amazon_returned_on is not null then
      new.is_accessory := false;
    end if;
    return new;
  end if;

  new.is_accessory := false;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if numeric_serial is null or separator_and_tail is null then
    return new;
  end if;

  -- Serialize return registrations for a product so concurrent submissions
  -- cannot receive the same suffix.
  perform pg_advisory_xact_lock(hashtextextended('amazon-return:' || new.lot_seq::text || ':' || numeric_serial, 179049));

  select coalesce(max(length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''))), 0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and (regexp_match(i.sku, '^([0-9]+)'))[1] = numeric_serial;

  requested_depth := length(coalesce((regexp_match(new.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  return new;
end;
$$;

revoke all on function app.enforce_amazon_return_main_item() from public, anon, authenticated;
drop trigger if exists items_enforce_amazon_return_main_item on app.items;
create trigger items_enforce_amazon_return_main_item
before insert or update of marketplace, is_accessory on app.items
for each row execute function app.enforce_amazon_return_main_item();

notify pgrst, 'reload schema';


-- ▼▼▼ 20261002125750_promote_legacy_amazon_return_accessories.sql ▼▼▼

-- These Amazon返品 rows were still classified as accessories and carried only
-- a sale date mirrored from their parent item. Promote them to independent main
-- items, preserve their old SKUs as aliases, and restore the return workflow.
with targets(old_sku, new_sku) as (
  values
    ('724-AAEE-20251208-298', '724a-AAEE-20251208-298'),
    ('780-AAHH-20251225-298', '780a-AAHH-20251225-298'),
    ('840-AAHH-20251224-0', '840a-AAHH-20251224-0'),
    ('1310-AAII-20260226-0', '1310a-AAII-20260226-0'),
    ('1586-AAHH-20260521-298', '1586a-AAHH-20260521-298'),
    ('1812-AAII-20260615-74', '1812a-AAII-20260615-74'),
    ('1929-AAHH-20260622-74', '1929a-AAHH-20260622-74'),
    ('1929-AAHH-20260715-74', '1929aa-AAHH-20260715-74')
)
update app.items i
set sku = t.new_sku,
    is_accessory = false,
    sold_on = null,
    status = 'Amazon返品',
    updated_at = now()
from targets t
where i.sku = t.old_sku
  and i.marketplace::text = 'Amazon返品'
  and i.is_accessory
  and i.status::text = '販売済'
  and i.sold_on is not null
  and i.sold_price is null
  and i.payout_amount is null;


-- ▼▼▼ 20261002130255_repair_remaining_amazon_return_serial_collision.sql ▼▼▼

-- A later Amazon返品 row was added with an already-used "a" serial after the
-- initial reconciliation. Give that third physical row its next distinct suffix.
update app.items
set sku = '1894aaa-II-18991230-0',
    updated_at = now()
where sku = '1894a-II-18991230-0'
  and lot_seq = 1894
  and marketplace::text = 'Amazon返品'
  and not is_accessory;


-- ▼▼▼ 20261002150000_inventory_sales_spares_and_master.sql ▼▼▼

-- Mirror a main item's sale date onto its attached accessories while keeping
-- accessory sale amounts empty to avoid double-counting revenue.
-- Install the accessory-safe status trigger before backfilling dates, otherwise
-- old accessory rows are marked sold and violate the sale-price constraint.
create or replace function app.items_mark_sold()
returns trigger language plpgsql as $$
begin
  if new.sold_on is not null
     and not new.is_accessory
     and new.status <> '返品処理'
     and new.amazon_returned_on is null then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then
    new.status := '返品処理';
  end if;
  return new;
end;
$$;

-- Attached accessories carry the parent's sale date but never its revenue.
-- Permit a sold status with no sale amount for those informational rows.
alter table app.items drop constraint if exists items_sold_requires_date;
alter table app.items add constraint items_sold_requires_date check (
  status <> '販売済' or (sold_on is not null and (sold_price is not null or is_accessory))
);

-- Show the return source under supplier; retain the special status internally
-- because delivery and reconciliation workflows use it as a processing marker.
update app.items
set marketplace = 'Amazon返品'
where (status = 'Amazon返品' or amazon_returned_on is not null)
  and marketplace is distinct from 'Amazon返品';

update app.items accessory
set sold_on = parent.sold_on, sold_price = null, payout_amount = null
from app.items parent
where accessory.is_accessory
  and not parent.is_accessory
  and accessory.lot_seq = parent.lot_seq
  and app.product_serial(accessory.sku, accessory.lot_seq) = app.product_serial(parent.sku, parent.lot_seq);

update app.items item set asin=product.asin
from app.products product
where item.product_id=product.id and item.asin is distinct from product.asin;

-- Inventory reimbursements are separate from buyer refunds in the UI.
alter table app.items add column if not exists inventory_refund_amount bigint not null default 0 check (inventory_refund_amount >= 0);

create or replace function app.keep_accessory_sale_amounts_empty()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_accessory then
    new.sold_price := null;
    new.payout_amount := null;
  end if;
  return new;
end;
$$;
revoke all on function app.keep_accessory_sale_amounts_empty() from public, anon, authenticated;
drop trigger if exists items_keep_accessory_sale_amounts_empty on app.items;
create trigger items_keep_accessory_sale_amounts_empty
before insert or update of is_accessory, sold_price, payout_amount on app.items
for each row execute function app.keep_accessory_sale_amounts_empty();

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.is_accessory and (new.sold_on is distinct from old.sold_on
      or new.sold_price is distinct from old.sold_price
      or new.payout_amount is distinct from old.payout_amount) then
    update app.items accessory
       set sold_on = new.sold_on, sold_price = null, payout_amount = null
     where accessory.is_accessory
       and accessory.lot_seq = new.lot_seq
       and app.product_serial(accessory.sku, accessory.lot_seq) = app.product_serial(new.sku, new.lot_seq);
  end if;
  return new;
end;
$$;
revoke all on function app.sync_accessory_sale_date() from public, anon, authenticated;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after update of sold_on, sold_price, payout_amount on app.items
for each row execute function app.sync_accessory_sale_date();

create or replace function app.sync_inventory_shared_product_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.asin is distinct from old.asin then
    update app.items sibling set asin=new.asin
     where sibling.id<>new.id and sibling.product_id=new.product_id and new.product_id is not null
       and sibling.asin is distinct from new.asin;
    update app.items sibling set asin=new.asin
     where sibling.id<>new.id and new.product_id is null
       and app.product_serial(sibling.sku,sibling.lot_seq)=app.product_serial(new.sku,new.lot_seq)
       and sibling.asin is distinct from new.asin;
  end if;
  if new.planned_price is distinct from old.planned_price or new.planned_payout is distinct from old.planned_payout then
    update app.items sibling set planned_price=new.planned_price, planned_payout=new.planned_payout
     where sibling.id<>new.id
       and app.product_serial(sibling.sku,sibling.lot_seq)=app.product_serial(new.sku,new.lot_seq)
       and (sibling.planned_price is distinct from new.planned_price or sibling.planned_payout is distinct from new.planned_payout);
  end if;
  return new;
end;
$$;
revoke all on function app.sync_inventory_shared_product_fields() from public, anon, authenticated;
drop trigger if exists items_sync_inventory_shared_product_fields on app.items;
create trigger items_sync_inventory_shared_product_fields
after update of asin, planned_price, planned_payout on app.items
for each row execute function app.sync_inventory_shared_product_fields();

create or replace function app.sync_product_asin_to_inventory()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.asin is distinct from old.asin then
    update app.items set asin=new.asin where product_id=new.id and asin is distinct from new.asin;
  end if;
  return new;
end;
$$;
revoke all on function app.sync_product_asin_to_inventory() from public, anon, authenticated;
drop trigger if exists products_sync_asin_to_inventory on app.products;
create trigger products_sync_asin_to_inventory
after update of asin on app.products
for each row execute function app.sync_product_asin_to_inventory();

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*, raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds + totals.inventory_refunds - inventory.product_cost
      - totals.shipping - totals.other_cost end as product_profit,
  raw.inventory_refund_amount
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join lateral (select body from app.item_comments where item_id=inventory.id order by created_at desc,id desc limit 1) latest on true
left join lateral (
  select sum(refund_amount) as refunds, sum(inventory_refund_amount) as inventory_refunds,
    sum(shipping_cost) as shipping, sum(other_cost) as other_cost
  from app.items where app.product_serial(sku,lot_seq)=app.product_serial(raw.sku,raw.lot_seq)
) totals on true;
grant select on app.v_inventory_display to authenticated;

create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then return new; end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>new.id
      and i.sold_on is not null and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null and i.returned_on is null
      and i.marketplace is distinct from 'Amazon返品' and i.status not in ('Amazon返品','返品処理','廃棄')) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end; $$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;

-- Only the active 長部一輝 delivery account bypasses photo review for pack/ship.
create or replace function app.is_delivery_master()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from app.profiles p join app.staff s on s.id = p.staff_id
    where p.user_id = auth.uid() and s.name = '長部一輝' and s.is_active and s.role = 'admin'
  );
$$;
revoke all on function app.is_delivery_master() from public, anon;
grant execute on function app.is_delivery_master() to authenticated;

create or replace function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 if p_done and p_step in ('packed','shipped') and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;

create or replace function app.require_photo_review(p_item_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if app.photo_review_enforced() and not app.is_delivery_master()
     and not exists (select 1 from app.photo_reviews where item_id=p_item_id and approved_at is not null) then
    raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
  end if;
end $$;

-- Keep previous sales intact. When Amazon sends the original numeric SKU after
-- a return, apply the new sale to the most recently created returned suffix row.
create or replace function app.apply_amazon_sale(
  p_account text,p_transaction text,p_sku text,p_asin text,p_sold_on date,p_price bigint,p_payout bigint,p_actor uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_count integer; serial_key text; root_serial text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status='RELEASED';
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  serial_key:=app.product_serial(p_sku,null);
  root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
  if serial_key is null then return jsonb_build_object('status','review','reason','SKUの商品番号を読み取れません。'); end if;
  -- Any returned row wins over the original SKU, even when Amazon reports only
  -- the numeric SKU. Suffix depth orders 100, 100a, 100aa chronologically.
  select id into target_id from app.items
   where not is_accessory and (regexp_match(sku,'^([0-9]+)'))[1]=root_serial
     and (amazon_returned_on is not null or returned_on is not null or status in ('Amazon返品','返品処理'))
   order by length(regexp_replace(app.product_serial(sku,lot_seq),'^[0-9]+','')) desc,
            coalesce(amazon_returned_on,returned_on) desc nulls last, updated_at desc, id desc
   limit 1;
  if target_id is null then
    select id into target_id from app.items where sku=p_sku and not is_accessory order by id limit 1;
  end if;
  if target_id is null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items
      where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then target_id:=null; end if;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・返品在庫が見つかりません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if inventory.status in ('廃棄') or (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','廃棄、または仕入日より前の販売のため確認が必要です。'); end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif inventory.sold_on is not null or inventory.sold_price is not null or inventory.payout_amount is not null then
    return jsonb_build_object('status','review','reason','対象の返品行に既存の販売記録があります。上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout,status='販売済' where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を返品後の在庫行に反映しました。','item_id',inventory.id);
end; $$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;

-- Keep refund/reimbursement transaction provenance idempotent per exact Amazon
-- transaction and SKU; repeated imports adjust only that transaction's delta.
create table app.amazon_refund_matches (
  account_key text not null,
  marketplace_id text not null,
  transaction_id text not null,
  sku text not null,
  item_id uuid not null references app.items(id),
  refund_kind text not null check (refund_kind in ('inventory','amazon_refund')),
  amount bigint not null check (amount >= 0),
  applied_by uuid not null references auth.users(id),
  applied_at timestamptz not null default now(),
  primary key(account_key,marketplace_id,transaction_id,sku)
);
alter table app.amazon_refund_matches enable row level security;
revoke all on app.amazon_refund_matches from public,anon,authenticated;
grant select,insert,update on app.amazon_refund_matches to service_role;

create or replace function app.apply_amazon_refund(p_account text,p_transaction text,p_sku text,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare txn app.amazon_payment_transactions%rowtype; kind text; amount_value bigint; target app.items%rowtype; prior app.amazon_refund_matches%rowtype; delta bigint;
begin
 if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
 select * into txn from app.amazon_payment_transactions where account_key=p_account and marketplace_id='A1VC38T7YXB528' and transaction_id=p_transaction;
 if not found or txn.status <> 'RELEASED' then return jsonb_build_object('status','review','reason','支払い実行済みのAmazon取引が見つかりません。'); end if;
 kind:=case when lower(coalesce(txn.transaction_type,'')) in ('inventory reimbursement','inventoryreimbursement','fba inventory reimbursement','fbainventoryreimbursement','fba_inventory_reimbursement') then 'inventory'
            when lower(coalesce(txn.transaction_type,''))='refund' then 'amazon_refund' else null end;
 if kind is null then return jsonb_build_object('status','review','reason','対象外の取引種類です。'); end if;
 if (select count(*) from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku)<>1 then return jsonb_build_object('status','review','reason','SKUを取引内で一意に特定できません。'); end if;
 select abs((e->>'amount')::numeric)::bigint into amount_value from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$';
 if amount_value is null then return jsonb_build_object('status','review','reason','SKU別の返金額が円の整数として確認できません。'); end if;
 select * into target from app.items where sku=p_sku and not is_accessory for update;
 if not found then return jsonb_build_object('status','review','reason','SKUが在庫一覧にありません。'); end if;
 select * into prior from app.amazon_refund_matches where account_key=p_account and marketplace_id=txn.marketplace_id and transaction_id=p_transaction and sku=p_sku;
 delta:=amount_value-coalesce(prior.amount,0);
 if delta<>0 then
   if kind='inventory' then update app.items set inventory_refund_amount=greatest(inventory_refund_amount+delta,0) where id=target.id;
   else update app.items set amazon_refund_amount=greatest(amazon_refund_amount+delta,0) where id=target.id;
   end if;
 end if;
 insert into app.amazon_refund_matches(account_key,marketplace_id,transaction_id,sku,item_id,refund_kind,amount,applied_by)
 values(p_account,txn.marketplace_id,p_transaction,p_sku,target.id,kind,amount_value,p_actor)
 on conflict(account_key,marketplace_id,transaction_id,sku) do update set item_id=excluded.item_id,refund_kind=excluded.refund_kind,amount=excluded.amount,applied_by=excluded.applied_by,applied_at=now();
 return jsonb_build_object('status',case when prior.amount is null then 'applied' when delta=0 then 'unchanged' else 'applied' end,'reason',case when kind='inventory' then '在庫の払い戻しを反映しました。' else 'Amazon返金金額を反映しました。' end,'amount',amount_value,'sku',p_sku);
end $$;
revoke all on function app.apply_amazon_refund(text,text,text,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_refund(text,text,text,uuid) to service_role;

notify pgrst, 'reload schema';


-- ▼▼▼ 20261002160000_delivery_task_model_search_and_item_classification.sql ▼▼▼

-- Delivery task search needs the product-list model number in addition to title.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
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
  (i.inspected_at is not null) as inspected,
  (i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,
  i.shipped_on,
  i.amazon_returned_on,
  p.image_url as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id = i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id = i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,
  i.description_template,
  i.manufacture_year,
  i.marketplace_item_id,
  p.model_no as model_no
from app.items i
left join app.products p on p.id = i.product_id
left join app.staff buyer on buyer.id = i.purchaser_id
where i.status in ('仕入済', '入荷済', '作業中', 'Amazon返品', '出荷済', '出品中', '販売済');

-- These SKUs are complete products, not attached accessories. The first row was
-- misclassified because the old import inferred accessory status from missing
-- planned price; the second inherited a stale '(付)' delivery prefix.
update app.items
set is_accessory=false, work_stream='その他'::app.work_stream, updated_at=now()
where sku='2389-AADD-20260929-710' and is_accessory;

update app.items
set is_accessory=false, work_stream='ブルーレイ'::app.work_stream, updated_at=now()
where sku='2390-AALL-20260929-2500' and is_accessory;

notify pgrst, 'reload schema';


-- ▼▼▼ 20261002170000_fix_return_sale_guard.sql ▼▼▼

-- Keep returned items eligible for a new sale without weakening duplicate-sale
-- protection for items whose supplier is NULL.
create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then
    return new;
  end if;
  if new.sold_on is null
     or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then
    return new;
  end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id
      and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null
      and i.returned_on is null
      and i.marketplace is distinct from 'Amazon返品'
      and i.status not in ('Amazon返品','返品処理','廃棄')
  ) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;


-- ▼▼▼ 20261002180000_inventory_product_serial_lookup_index.sql ▼▼▼

-- Speed up the per-product rollups used by the inventory display view.
-- Without this expression index, each displayed item scans all inventory rows
-- to find its product siblings, which makes the page time out as data grows.
create index if not exists items_product_serial_financial_idx
  on app.items (app.product_serial(sku, lot_seq))
  include (refund_amount, inventory_refund_amount, shipping_cost, other_cost);


-- ▼▼▼ 20261002190000_materialize_inventory_product_groups.sql ▼▼▼

-- Compute product rollups once per request and join each item through the
-- product-serial index. PostgreSQL otherwise expands both views and may choose
-- a nested-loop join that compares every inventory row with every product group.
create or replace view app.v_inventory_items with (security_invoker = true) as
with groups as materialized (
  select * from app.v_product_groups
)
select i.*,g.product_row_count,g.product_cost,g.sale_row_count,g.product_sale_conflict,
  g.product_sold_on,g.product_sold_price,g.product_payout_amount
from app.v_items i
join groups g on g.serial_key=app.product_serial(i.sku,i.lot_seq);

grant select on app.v_inventory_items to authenticated;


-- ▼▼▼ 20261002200000_cache_inventory_policy_identity.sql ▼▼▼

-- Evaluate stable identity lookups once per statement instead of once per row.
-- This preserves the existing access rules while keeping authenticated inventory
-- queries fast as the number of inventory rows grows.
drop policy if exists items_select on app.items;
create policy items_select on app.items
  for select to authenticated
  using (
    (select app."current_role"()) = any(array['admin'::app.staff_role, 'purchaser'::app.staff_role])
    or deliverer_id = (select app.current_staff_id())
  );

drop policy if exists item_comments_select on app.item_comments;
create policy item_comments_select on app.item_comments
  for select to authenticated
  using (
    exists (
      select 1 from app.items i
      where i.id = item_comments.item_id
        and (
          (select app."current_role"()) = any(array['admin'::app.staff_role, 'purchaser'::app.staff_role])
          or i.deliverer_id = (select app.current_staff_id())
        )
    )
  );


-- ▼▼▼ 20261002201234_delivery_pdf_return_profit_and_auction_workdays.sql ▼▼▼

alter type app.marketplace add value if not exists '動作品Amazon返品';

update storage.buckets
set allowed_mime_types = array(
  select distinct t.mime
  from unnest(coalesce(allowed_mime_types, '{}'::text[]) || array['application/pdf','image/jpeg']::text[]) as t(mime)
)
where id='invoice-receipts';

alter table app.invoice_receipts
  add column if not exists document_type text not null default 'receipt_photo',
  add column if not exists mime_type text not null default 'image/jpeg';
alter table app.invoice_receipts drop constraint if exists invoice_receipts_check;
alter table app.invoice_receipts drop constraint if exists invoice_receipts_document_type_check;
alter table app.invoice_receipts drop constraint if exists invoice_receipts_mime_type_check;
alter table app.invoice_receipts add constraint invoice_receipts_check check (
  storage_path ~ ('^'||staff_id::text||'/'||to_char(billing_month,'YYYY-MM')||'/[0-9a-f-]{36}\.(jpg|pdf)$')
);
alter table app.invoice_receipts add constraint invoice_receipts_document_type_check
  check (document_type in ('invoice','receipt','receipt_photo'));
alter table app.invoice_receipts add constraint invoice_receipts_mime_type_check
  check ((storage_path like '%.pdf' and mime_type='application/pdf') or (storage_path like '%.jpg' and mime_type='image/jpeg'));
grant insert(document_type,mime_type) on app.invoice_receipts to authenticated;

create or replace function app.fill_receipt_submission() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',id,'storage_path',storage_path,'original_name',original_name,
   'document_type',document_type,'mime_type',mime_type
 ) order by created_at,id),'[]'::jsonb)
 into new.files from app.invoice_receipts
 where staff_id=new.staff_id and billing_month=new.billing_month and document_type in ('receipt','receipt_photo');
 if jsonb_array_length(new.files)=0 then raise exception '領収書または領収書の写真を追加してください'; end if;
 new.submitted_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;

create or replace function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false)
   and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' and not coalesce(photo_exempt,false) then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;
revoke all on function app.set_delivery_progress(uuid,text,boolean,date) from public,anon,authenticated;
grant execute on function app.set_delivery_progress(uuid,text,boolean,date) to authenticated;

create or replace function app.require_photo_review(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if app.photo_review_enforced() and not app.is_delivery_master()
     and not exists(select 1 from app.items where id=p_item_id and marketplace::text='動作品Amazon返品')
     and not exists (select 1 from app.photo_reviews where item_id=p_item_id and approved_at is not null) then
    raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
  end if;
end $$;
revoke all on function app.require_photo_review(uuid) from public,anon,authenticated;

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  i.sales_channel,i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,p.image_url as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no
from app.items i
left join app.products p on p.id=i.product_id
left join app.staff buyer on buyer.id=i.purchaser_id
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;

create or replace function app.monthly_gross_profit_by_purchaser(p_purchaser_id uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare current_id uuid:=app.current_staff_id(); current_user_role text:=app.current_role(); result jsonb;
begin
 if auth.uid() is null or current_id is null or p_month is null or extract(day from p_month)<>1 then
  raise exception '対象月またはログイン情報が不正です' using errcode='22023';
 end if;
 if current_user_role='admin' then
  if p_purchaser_id is null or not exists(select 1 from app.staff where id=p_purchaser_id and is_active and role in ('admin','purchaser')) then
   raise exception '仕入担当者を選択してください' using errcode='22023';
  end if;
 elsif current_user_role='purchaser' then
  if p_purchaser_id is distinct from current_id then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 elsif current_user_role='deliverer' then
  if p_purchaser_id is not null then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 else raise exception '閲覧する権限がありません' using errcode='42501'; end if;

 with candidates as (
  select app.product_serial(i.sku,i.lot_seq) as serial_key,i.sku,
    d.product_sold_on as sold_on,owner.name as purchaser_name,
    d.product_profit as gross_profit,i.created_at
  from app.items i
  join app.v_inventory_display d on d.id=i.id
  left join app.staff owner on owner.id=i.purchaser_id
  where not i.is_accessory and not d.product_sale_conflict
    and d.product_sold_on>=p_month and d.product_sold_on<p_month+interval '1 month'
    and d.product_profit is not null
    and ((current_user_role='admin' and i.purchaser_id=p_purchaser_id)
      or (current_user_role='purchaser' and i.purchaser_id=current_id)
      or (current_user_role='deliverer' and i.deliverer_id=current_id))
 ), products as (
  select distinct on(serial_key) serial_key,sku,sold_on,purchaser_name,gross_profit
  from candidates order by serial_key,created_at,sku
 )
 select jsonb_build_object(
  'rows',coalesce(jsonb_agg(jsonb_build_object('sku',sku,'sold_on',sold_on,'purchaser_name',purchaser_name,'gross_profit',gross_profit) order by sold_on,sku),'[]'::jsonb),
  'total',coalesce(sum(gross_profit),0)
 ) into result from products;
 return result;
end $$;
revoke all on function app.monthly_gross_profit_by_purchaser(uuid,date) from public,anon,authenticated;
grant execute on function app.monthly_gross_profit_by_purchaser(uuid,date) to authenticated;

create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint; monthly_profit bigint:=0;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then raise exception '請求書へのアクセス権がありません' using errcode='42501'; end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 with bodies as (
  select distinct on(app.product_serial(sku,lot_seq)) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,sku
  from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
  order by app.product_serial(sku,lot_seq),packed_on,id
 ), selected as (select * from bodies where packed_on>=p_month and packed_on<p_month+interval '1 month')
 select coalesce(jsonb_agg(jsonb_build_object('item_id',id,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
   'description',case when marketplace::text='動作品Amazon返品' then '動作品Amazon返品対応'
     when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
     when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
   'title',title,'quantity',1,
   'unit_price',case when marketplace::text='動作品Amazon返品' then floor(p.unit_price/2.0)::integer else p.unit_price end,
   'amount',case when marketplace::text='動作品Amazon返品' then floor(p.unit_price/2.0)::integer else p.unit_price end
  ) order by packed_on,lot_seq),'[]'::jsonb),coalesce(sum(case when marketplace::text='動作品Amazon返品' then floor(p.unit_price/2.0)::integer else p.unit_price end),0)
 into lines,subtotal from selected;
 if p.details->>'issuer_name'='石川秀樹' then
  monthly_profit:=coalesce((app.monthly_gross_profit_by_purchaser(p_staff,p_month)->>'total')::bigint,0);
 end if;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent,
  'purchaser_gross_profit',monthly_profit);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

create or replace function app.fill_delivery_invoice()
returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare doc jsonb; line jsonb; normalized jsonb:='[]'; qty integer; price bigint; sub bigint; tax bigint; date_value date;
  is_ishikawa boolean; workday_count integer:=0; gross bigint:=0; percent_amount bigint:=0; base_amount bigint:=0;
begin
 if jsonb_typeof(new.extras)<>'array' or jsonb_array_length(new.extras)>100 then raise exception '追加明細は100行以内で入力してください'; end if;
 doc:=app.prepare_delivery_invoice(new.staff_id,new.billing_month);
 sub:=(doc->>'subtotal')::bigint;
 is_ishikawa:=doc->'profile'->>'issuer_name'='石川秀樹';
 gross:=coalesce((doc->>'purchaser_gross_profit')::bigint,0);
 for line in select value from jsonb_array_elements(new.extras) loop
  if jsonb_typeof(line)<>'object' or length(trim(coalesce(line->>'description','')))=0 or length(line->>'description')>200
  or coalesce(line->>'quantity','') !~ '^[0-9]+$' or coalesce(line->>'unit_price','') !~ '^[0-9]+$' then
   raise exception '追加明細の内容・数量・単価を確認してください';
  end if;
  if line->>'description'='粗利益連動調整' then continue; end if;
  qty:=(line->>'quantity')::integer; price:=(line->>'unit_price')::bigint;
  date_value:=nullif(line->>'date','')::date;
  if line->>'description'='ヤフオク入札作業日' then
   if not is_ishikawa or qty<>1 or price<>4500 or date_value is null
    or date_value<new.billing_month or date_value>=new.billing_month+interval '1 month' then
    raise exception 'ヤフオク入札作業日は石川秀樹の対象月内の日付で登録してください';
   end if;
   if exists(select 1 from jsonb_array_elements(normalized) x where x->>'description'='ヤフオク入札作業日' and x->>'date'=date_value::text) then
    raise exception '同じ作業日が重複しています';
   end if;
   normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description','ヤフオク入札作業日','quantity',1,'unit_price',4500,'amount',4500));
   workday_count:=workday_count+1; sub:=sub+4500;
   continue;
  end if;
  if qty<1 or qty>100000 or price<0 or price>10000000 then raise exception '追加明細の金額が範囲外です'; end if;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description',trim(line->>'description'),'quantity',qty,'unit_price',price,'amount',qty*price));
  sub:=sub+qty*price;
 end loop;
 if is_ishikawa then
  base_amount:=workday_count*4500;
  percent_amount:=floor(greatest(gross,0)*0.10)::bigint;
  if percent_amount>base_amount then
   normalized:=normalized||jsonb_build_array(jsonb_build_object('date',null,'description','粗利益連動調整','quantity',1,'unit_price',percent_amount-base_amount,'amount',percent_amount-base_amount));
   sub:=sub+(percent_amount-base_amount);
  end if;
 end if;
 tax:=floor(sub*(doc->>'tax_percent')::numeric/100);
 new.extras:=normalized;
 new.snapshot:=doc||jsonb_build_object('extras',normalized,'subtotal',sub,'tax',tax);
 new.total:=sub+tax;
 new.updated_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_delivery_invoice() from public,anon,authenticated;

notify pgrst,'reload schema';


-- ▼▼▼ 20261002210000_preaggregate_inventory_financials.sql ▼▼▼

-- The per-row financial rollup in v_inventory_display forces a full RLS-filtered
-- items scan for every item. Aggregate once per statement and join by product key.
create or replace view app.v_inventory_display with (security_invoker = true) as
with totals as materialized (
  select app.product_serial(i.sku, i.lot_seq) as serial_key,
    sum(i.refund_amount) as refunds,
    sum(i.inventory_refund_amount) as inventory_refunds,
    sum(i.shipping_cost) as shipping,
    sum(i.other_cost) as other_cost
  from app.items i
  group by app.product_serial(i.sku, i.lot_seq)
)
select inventory.*, raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds + totals.inventory_refunds
      - inventory.product_cost - totals.shipping - totals.other_cost end as product_profit,
  raw.inventory_refund_amount
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join totals on totals.serial_key=app.product_serial(raw.sku,raw.lot_seq)
left join lateral (
  select body from app.item_comments
  where item_id=inventory.id
  order by created_at desc,id desc
  limit 1
) latest on true;

grant select on app.v_inventory_display to authenticated;


-- ▼▼▼ 20261003010000_spare_remote_transfer_and_metadata.sql ▼▼▼

alter table app.spare_accessories
  add column if not exists manufacturer text,
  add column if not exists model_no text,
  add column if not exists asin text;

create or replace function app.move_inventory_accessory_to_spares(
  p_item_id uuid,
  p_spare_input jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item app.items%rowtype;
  v_spare_id uuid;
  v_owner_id uuid;
  v_owner_name text;
  v_registered_lot integer;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備一覧へ登録する権限がありません' using errcode='42501';
  end if;
  if p_spare_input is null or jsonb_typeof(p_spare_input) <> 'object' then
    raise exception 'リモコン情報が不正です' using errcode='22023';
  end if;

  select * into v_item from app.items where id=p_item_id for update;
  if not found then raise exception '在庫一覧のリモコン行が見つかりません' using errcode='P0002'; end if;
  if not v_item.is_accessory or v_item.title not ilike '%リモコン%' then
    raise exception '対象は付属品登録されたリモコン行ではありません' using errcode='22023';
  end if;
  if app.current_role() = 'purchaser' and v_item.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外のリモコン行は移動できません' using errcode='42501';
  end if;
  if coalesce(p_spare_input->>'usage_note','') !~ '^[0-9]+[a-z]*$' then
    raise exception '利用記録に通番号を入力してください' using errcode='22023';
  end if;
  v_registered_lot := substring(p_spare_input->>'usage_note' from '^([0-9]+)')::integer;
  if v_registered_lot is distinct from v_item.lot_seq then
    raise exception '入力した通番号と在庫行の通番号が一致しません' using errcode='22023';
  end if;

  v_owner_id := coalesce(nullif(p_spare_input->>'owner_staff_id','')::uuid, v_item.purchaser_id, app.current_staff_id());
  if app.current_role() = 'purchaser' and v_owner_id is distinct from app.current_staff_id() then
    raise exception '自分の予備としてのみ登録できます' using errcode='42501';
  end if;
  select name into v_owner_name from app.staff where id=v_owner_id;
  v_owner_name := coalesce(nullif(btrim(p_spare_input->>'owner_name'),''),v_owner_name);
  if nullif(btrim(p_spare_input->>'title'),'') is null then
    raise exception '品名を入力してください' using errcode='22023';
  end if;
  if coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount) < 0 then
    raise exception '仕入金額は0円以上で入力してください' using errcode='22023';
  end if;

  insert into app.spare_accessories (
    source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
    cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
  ) values (
    coalesce(nullif(p_spare_input->>'source_sku',''),v_item.sku),
    v_owner_id,v_owner_name,
    coalesce(nullif(p_spare_input->>'purchased_at','')::date,v_item.purchased_at),
    btrim(p_spare_input->>'title'),
    nullif(btrim(p_spare_input->>'manufacturer'),''),
    nullif(btrim(p_spare_input->>'model_no'),''),
    nullif(btrim(p_spare_input->>'asin'),''),
    coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount),
    nullif(p_spare_input->>'marketplace',''),
    nullif(p_spare_input->>'marketplace_item_id',''),
    nullif(p_spare_input->>'tracking_no',''),
    p_spare_input->>'usage_note'
  ) returning id into v_spare_id;

  delete from app.items where id=v_item.id;
  return v_spare_id;
end;
$$;

revoke all on function app.move_inventory_accessory_to_spares(uuid,jsonb) from public,anon;
grant execute on function app.move_inventory_accessory_to_spares(uuid,jsonb) to authenticated;


-- ▼▼▼ 20261003020000_amazon_refund_locale_and_sku_sequence.sql ▼▼▼

create or replace function app.apply_amazon_refund(p_account text,p_transaction text,p_sku text,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 txn app.amazon_payment_transactions%rowtype;
 kind text;
 amount_value bigint;
 target app.items%rowtype;
 prior app.amazon_refund_matches%rowtype;
 delta bigint;
 root_serial text;
 matching_refunds integer;
begin
 if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
 select * into txn from app.amazon_payment_transactions where account_key=p_account and marketplace_id='A1VC38T7YXB528' and transaction_id=p_transaction;
 if not found or txn.status not in ('RELEASED','支払い実行済み') then return jsonb_build_object('status','review','reason','支払い実行済みのAmazon取引が見つかりません。'); end if;
 kind:=case when lower(coalesce(txn.transaction_type,'')) in ('inventory reimbursement','inventoryreimbursement','fba inventory reimbursement','fbainventoryreimbursement','fba_inventory_reimbursement','在庫の払い戻し','在庫払い戻し') then 'inventory'
            when lower(coalesce(txn.transaction_type,'')) in ('refund','返金') then 'amazon_refund' else null end;
 if kind is null then return jsonb_build_object('status','review','reason','対象外の取引種類です。'); end if;
 if (select count(*) from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku)<>1 then return jsonb_build_object('status','review','reason','SKUを取引内で一意に特定できません。'); end if;
 select abs((e->>'amount')::numeric)::bigint into amount_value from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$';
 if amount_value is null then return jsonb_build_object('status','review','reason','SKU別の返金額が円の整数として確認できません。'); end if;

 root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
 if root_serial is null then return jsonb_build_object('status','review','reason','Amazon SKUから通番号を読み取れません。'); end if;
 select count(*) into matching_refunds
 from app.amazon_payment_transactions t
 where t.account_key=p_account and t.marketplace_id=txn.marketplace_id
   and lower(coalesce(t.transaction_type,'')) in ('refund','返金')
   and t.status in ('RELEASED','支払い実行済み')
   and (t.posted_at,t.transaction_id)<=(txn.posted_at,txn.transaction_id)
   and exists (
     select 1 from jsonb_array_elements(t.item_breakdowns) e
     where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$'
   );

 if matching_refunds>1 then
   -- Identical Amazon SKU refunds are assigned oldest first: base serial, then a, aa, etc.
   select * into target from app.items i
   where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial
   order by length(coalesce((regexp_match(app.product_serial(i.sku,i.lot_seq),'^[0-9]+([a-z]*)$'))[1],'')),
            app.product_serial(i.sku,i.lot_seq),i.sku
   offset matching_refunds-1 limit 1;
   if not found then return jsonb_build_object('status','review','reason','同じSKUの返品回数に対応する本体行がありません。SKU順の在庫を確認してください。'); end if;
 else
   select * into target from app.items where lower(sku)=lower(p_sku) and not is_accessory;
   if not found then
     select count(*) into matching_refunds from app.items i
      where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial;
     if matching_refunds<>1 then return jsonb_build_object('status','review','reason','対応する在庫行を一意に特定できません。'); end if;
     select * into target from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial;
   end if;
 end if;

 select * into prior from app.amazon_refund_matches where account_key=p_account and marketplace_id=txn.marketplace_id and transaction_id=p_transaction and sku=p_sku;
 if prior.amount is not null and prior.item_id<>target.id then
   return jsonb_build_object('status','review','reason','以前の反映先と今回のSKU順割当が異なるため、自動で移し替えません。管理者の確認が必要です。');
 end if;
 delta:=amount_value-coalesce(prior.amount,0);
 if delta<>0 then
   if kind='inventory' then update app.items set inventory_refund_amount=greatest(inventory_refund_amount+delta,0) where id=target.id;
   else update app.items set amazon_refund_amount=greatest(amazon_refund_amount+delta,0) where id=target.id;
   end if;
 end if;
 insert into app.amazon_refund_matches(account_key,marketplace_id,transaction_id,sku,item_id,refund_kind,amount,applied_by)
 values(p_account,txn.marketplace_id,p_transaction,p_sku,target.id,kind,amount_value,p_actor)
 on conflict(account_key,marketplace_id,transaction_id,sku) do update set item_id=excluded.item_id,refund_kind=excluded.refund_kind,amount=excluded.amount,applied_by=excluded.applied_by,applied_at=now();
 return jsonb_build_object('status',case when prior.amount is null then 'applied' when delta=0 then 'unchanged' else 'applied' end,
   'reason',case when kind='inventory' then '在庫の払い戻しを反映しました。' else 'Amazon返金金額を反映しました。' end,
   'amount',amount_value,'sku',p_sku,'item_id',target.id);
end $$;
revoke all on function app.apply_amazon_refund(text,text,text,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_refund(text,text,text,uuid) to service_role;

notify pgrst,'reload schema';


-- ▼▼▼ 20261003030000_item_malfunction_tasks.sql ▼▼▼

alter table app.items
  add column if not exists malfunction_reported boolean not null default false,
  add column if not exists malfunction_comment text,
  add column if not exists malfunction_reported_at timestamptz,
  add column if not exists malfunction_reported_by uuid references app.staff(id) on delete set null,
  add column if not exists malfunction_resolved_at timestamptz,
  add column if not exists malfunction_resolved_by uuid references app.staff(id) on delete set null;

alter table app.items drop constraint if exists items_malfunction_comment_check;
alter table app.items add constraint items_malfunction_comment_check check (
  malfunction_comment is null or length(malfunction_comment)<=2000
);
create index if not exists items_malfunction_tasks_idx
  on app.items(malfunction_reported_at desc) where malfunction_reported and malfunction_resolved_at is null;

create or replace function app.report_item_malfunction(p_item_id uuid,p_comment text)
returns void language plpgsql security definer set search_path='' as $$
declare staff_id uuid:=app.current_staff_id();
begin
 if auth.uid() is null or staff_id is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if length(btrim(coalesce(p_comment,'')))=0 or length(p_comment)>2000 then raise exception '動作不良の内容を2000文字以内で入力してください' using errcode='22023'; end if;
 perform app.assert_can_work_on(p_item_id);
 update app.items set malfunction_reported=true,malfunction_comment=btrim(p_comment),
   malfunction_reported_at=clock_timestamp(),malfunction_reported_by=staff_id,
   malfunction_resolved_at=null,malfunction_resolved_by=null
 where id=p_item_id;
 if not found then raise exception '商品が見つかりません' using errcode='P0002'; end if;
end $$;
revoke all on function app.report_item_malfunction(uuid,text) from public,anon,authenticated;
grant execute on function app.report_item_malfunction(uuid,text) to authenticated;

create or replace function app.resolve_item_malfunction(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 update app.items set malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=app.current_staff_id()
 where id=p_item_id and malfunction_reported and malfunction_resolved_at is null;
 if not found then raise exception '未対応の動作不良タスクが見つかりません' using errcode='P0002'; end if;
end $$;
revoke all on function app.resolve_item_malfunction(uuid) from public,anon,authenticated;
grant execute on function app.resolve_item_malfunction(uuid) to authenticated;

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  i.sales_channel,i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,p.image_url as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at
from app.items i
left join app.products p on p.id=i.product_id
left join app.staff buyer on buyer.id=i.purchaser_id
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;

notify pgrst,'reload schema';


-- ▼▼▼ 20261004100000_delivery_task_amazon_image_asin_fallback.sql ▼▼▼

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  i.sales_channel,i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at
from app.items i
left join app.products p on p.id=i.product_id
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');

grant select on app.v_delivery_tasks to authenticated;


-- ▼▼▼ 20261004140000_route_malfunction_reports_to_purchaser.sql ▼▼▼

create or replace function app.resolve_item_malfunction(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare current_staff uuid:=app.current_staff_id();
begin
  if auth.uid() is null or not (
    app.is_admin()
    or (app.current_role()='purchaser' and exists (
      select 1 from app.items i where i.id=p_item_id and i.purchaser_id=current_staff
    ))
  ) then
    raise exception '対象商品の仕入担当者または管理者のみ対応できます' using errcode='42501';
  end if;
  update app.items set malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=current_staff
  where id=p_item_id and malfunction_reported and malfunction_resolved_at is null;
  if not found then raise exception '未対応の動作不良報告が見つかりません' using errcode='P0002'; end if;
end $$;
revoke all on function app.resolve_item_malfunction(uuid) from public,anon,authenticated;
grant execute on function app.resolve_item_malfunction(uuid) to authenticated;


-- ▼▼▼ 20261004160000_product_number_search_field.sql ▼▼▼

create or replace function app.product_no_search(app.products)
returns text
language sql
immutable
parallel safe
set search_path=pg_catalog,app
as $$
  select ($1).product_no::text
$$;

revoke all on function app.product_no_search(app.products) from public,anon;
grant execute on function app.product_no_search(app.products) to authenticated;

notify pgrst,'reload schema';


-- ▼▼▼ 20261004204258_sync_accessory_inventory_and_delivery_links.sql ▼▼▼

-- Keep main and accessory rows separate while synchronizing shared work and sale fields.
create or replace function app.redirect_accessory_shared_edits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent app.items%rowtype; parent_count integer;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.sold_on is distinct from old.sold_on or new.sold_price is distinct from old.sold_price
    or new.payout_amount is distinct from old.payout_amount
  ) then return new; end if;
  select count(*) into parent_count from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  if parent_count <> 1 then raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください'; end if;
  select i.* into parent from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq)
   for update;
  update app.items i set
    status=case when new.status is distinct from old.status then new.status else parent.status end,
    packed_on=case when new.packed_on is distinct from old.packed_on then new.packed_on else parent.packed_on end,
    shipped_on=case when new.shipped_on is distinct from old.shipped_on then new.shipped_on else parent.shipped_on end,
    sales_channel=case when new.sales_channel is distinct from old.sales_channel then new.sales_channel else parent.sales_channel end,
    sold_on=case when new.sold_on is distinct from old.sold_on then new.sold_on else parent.sold_on end,
    sold_price=case when new.sold_price is distinct from old.sold_price then new.sold_price else parent.sold_price end,
    payout_amount=case when new.payout_amount is distinct from old.payout_amount then new.payout_amount else parent.payout_amount end
  where i.id=parent.id;
  select i.* into parent from app.items i where i.id=parent.id;
  new.status:=parent.status;
  new.packed_on:=parent.packed_on;
  new.shipped_on:=parent.shipped_on;
  new.sales_channel:=parent.sales_channel;
  new.sold_on:=parent.sold_on;
  new.sold_price:=null;
  new.payout_amount:=null;
  return new;
end;
$$;
revoke all on function app.redirect_accessory_shared_edits() from public,anon,authenticated;
drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create trigger items_redirect_accessory_shared_edits
before update of status,packed_on,shipped_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.redirect_accessory_shared_edits();

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
     or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
     or new.sold_on is distinct from old.sold_on or new.sold_price is distinct from old.sold_price
     or new.payout_amount is distinct from old.payout_amount then
    update app.items accessory set status=new.status,packed_on=new.packed_on,shipped_on=new.shipped_on,
      sales_channel=new.sales_channel,sold_on=new.sold_on,sold_price=null,payout_amount=null
    where accessory.is_accessory and accessory.lot_seq=new.lot_seq
      and app.product_serial(accessory.sku,accessory.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  end if;
  return new;
end;
$$;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after update of status,packed_on,shipped_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.sync_accessory_sale_date();

create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel,sold_price bigint,payout_amount bigint)
language plpgsql stable security definer set search_path = '' as $$
declare target app.items%rowtype; source app.items%rowtype;
begin
  target:=app.assert_can_work_on(p_item_id);
  if target.is_accessory then
    select parent.* into source from app.items parent
    where not parent.is_accessory and parent.lot_seq=target.lot_seq
      and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq)
    order by parent.created_at,parent.id limit 1;
    if found then return query select source.sales_channel,source.sold_price,source.payout_amount; return; end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;
revoke all on function app.shared_product_sale_values(uuid) from public,anon;
grant execute on function app.shared_product_sale_values(uuid) to authenticated;
-- The delivery app reads the main row's actual price for both rows; accessory amounts stay NULL.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  case when i.is_accessory then shared.sales_channel else i.sales_channel end as sales_channel,
  i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id=i.product_id
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;

-- Correct the staff segment from assigned staff records on insert or assignment changes.
create or replace function app.set_working_return_sku_staff_codes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare purchaser_code text; deliverer_code text; parts text[];
begin
  if new.marketplace::text <> '動作品Amazon返品' or new.sku is null then return new; end if;
  if tg_op='UPDATE' and new.marketplace is not distinct from old.marketplace
     and new.purchaser_id is not distinct from old.purchaser_id
     and new.deliverer_id is not distinct from old.deliverer_id then return new; end if;
  select s.code into purchaser_code from app.staff s where s.id=new.purchaser_id;
  select s.code into deliverer_code from app.staff s where s.id=new.deliverer_id;
  parts:=string_to_array(new.sku,'-');
  if array_length(parts,1) <> 4 or parts[2] !~ '^[A-Z]{2,4}$' then
    raise exception '動作品Amazon返品のSKU形式を確認してください';
  end if;
  if purchaser_code is null and deliverer_code is null then
    raise exception 'SKUを作成するには仕入担当者か納品担当者が必要です';
  end if;
  new.sku:=parts[1]||'-'||coalesce(purchaser_code,'')||coalesce(deliverer_code,'')||'-'||parts[3]||'-'||parts[4];
  return new;
end;
$$;
revoke all on function app.set_working_return_sku_staff_codes() from public,anon,authenticated;
drop trigger if exists items_set_working_return_sku_staff_codes on app.items;
create trigger items_set_working_return_sku_staff_codes
before insert or update of marketplace,purchaser_id,deliverer_id on app.items
for each row execute function app.set_working_return_sku_staff_codes();

-- Repair existing rows from the deliverer assigned on each inventory record.
update app.items i set sku=split_part(i.sku,'-',1)||'-'||left(split_part(i.sku,'-',2),2)||deliverer.code||'-'||split_part(i.sku,'-',3)||'-'||split_part(i.sku,'-',4)
from app.staff deliverer
where i.marketplace::text='動作品Amazon返品'
  and i.deliverer_id=deliverer.id
  and substring(split_part(i.sku,'-',2) from 3 for 2) is distinct from deliverer.code;

notify pgrst,'reload schema';

-- ▼▼▼ 20261004204711_backfill_accessory_shared_state.sql ▼▼▼

-- Align historical accessory rows with their unique main item, keeping both rows separate.
drop trigger if exists items_redirect_accessory_shared_edits on app.items;
with candidate_pairs as (
  select accessory.id as accessory_id, parent.id as parent_id
  from app.items accessory
  join app.items parent on not parent.is_accessory
    and parent.lot_seq=accessory.lot_seq
    and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(accessory.sku,accessory.lot_seq)
  where accessory.is_accessory
), unique_pairs as (
  select accessory_id,(array_agg(parent_id))[1] as parent_id
  from candidate_pairs group by accessory_id having count(*)=1
)
update app.items accessory set
  status=parent.status,
  packed_on=parent.packed_on,
  shipped_on=parent.shipped_on,
  sales_channel=parent.sales_channel,
  sold_on=parent.sold_on,
  sold_price=null,
  payout_amount=null
from unique_pairs pair
join app.items parent on parent.id=pair.parent_id
where accessory.id=pair.accessory_id;
create trigger items_redirect_accessory_shared_edits
before update of status,packed_on,shipped_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.redirect_accessory_shared_edits();

-- Do not guess which main item to display when there are duplicate candidates.
create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel,sold_price bigint,payout_amount bigint)
language plpgsql stable security definer set search_path = '' as $$
declare target app.items%rowtype; source app.items%rowtype; parent_count integer;
begin
  target:=app.assert_can_work_on(p_item_id);
  if target.is_accessory then
    select count(*) into parent_count from app.items parent
    where not parent.is_accessory and parent.lot_seq=target.lot_seq
      and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq);
    if parent_count=1 then
      select parent.* into source from app.items parent
      where not parent.is_accessory and parent.lot_seq=target.lot_seq
        and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq);
      return query select source.sales_channel,source.sold_price,source.payout_amount;
      return;
    end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;
revoke all on function app.shared_product_sale_values(uuid) from public,anon;
grant execute on function app.shared_product_sale_values(uuid) to authenticated;
notify pgrst,'reload schema';

-- ▼▼▼ 20261004204917_sync_accessory_return_date.sql ▼▼▼

-- Returned date drives the 返品処理 status, so it must follow the main item too.
drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create or replace function app.redirect_accessory_shared_edits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent app.items%rowtype; parent_count integer;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.returned_on is distinct from old.returned_on
    or new.sales_channel is distinct from old.sales_channel or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
  ) then return new; end if;
  select count(*) into parent_count from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  if parent_count <> 1 then raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください'; end if;
  select i.* into parent from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq)
   for update;
  update app.items i set
    status=case when new.status is distinct from old.status then new.status else parent.status end,
    packed_on=case when new.packed_on is distinct from old.packed_on then new.packed_on else parent.packed_on end,
    shipped_on=case when new.shipped_on is distinct from old.shipped_on then new.shipped_on else parent.shipped_on end,
    returned_on=case when new.returned_on is distinct from old.returned_on then new.returned_on else parent.returned_on end,
    sales_channel=case when new.sales_channel is distinct from old.sales_channel then new.sales_channel else parent.sales_channel end,
    sold_on=case when new.sold_on is distinct from old.sold_on then new.sold_on else parent.sold_on end,
    sold_price=case when new.sold_price is distinct from old.sold_price then new.sold_price else parent.sold_price end,
    payout_amount=case when new.payout_amount is distinct from old.payout_amount then new.payout_amount else parent.payout_amount end
  where i.id=parent.id;
  select i.* into parent from app.items i where i.id=parent.id;
  new.status:=parent.status;
  new.packed_on:=parent.packed_on;
  new.shipped_on:=parent.shipped_on;
  new.returned_on:=parent.returned_on;
  new.sales_channel:=parent.sales_channel;
  new.sold_on:=parent.sold_on;
  new.sold_price:=null;
  new.payout_amount:=null;
  return new;
end;
$$;

-- Backfill the same fields on uniquely matched historical accessory rows.
with candidate_pairs as (
  select accessory.id as accessory_id,parent.id as parent_id
  from app.items accessory join app.items parent on not parent.is_accessory
    and parent.lot_seq=accessory.lot_seq
    and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(accessory.sku,accessory.lot_seq)
  where accessory.is_accessory
), unique_pairs as (
  select accessory_id,(array_agg(parent_id))[1] as parent_id
  from candidate_pairs group by accessory_id having count(*)=1
)
update app.items accessory set
  status=parent.status,packed_on=parent.packed_on,shipped_on=parent.shipped_on,
  returned_on=parent.returned_on,sales_channel=parent.sales_channel,sold_on=parent.sold_on,
  sold_price=null,payout_amount=null
from unique_pairs pair join app.items parent on parent.id=pair.parent_id
where accessory.id=pair.accessory_id;
create trigger items_redirect_accessory_shared_edits
before update of status,packed_on,shipped_on,returned_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.redirect_accessory_shared_edits();

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
     or new.shipped_on is distinct from old.shipped_on or new.returned_on is distinct from old.returned_on
     or new.sales_channel is distinct from old.sales_channel or new.sold_on is distinct from old.sold_on
     or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount then
    update app.items accessory set status=new.status,packed_on=new.packed_on,shipped_on=new.shipped_on,
      returned_on=new.returned_on,sales_channel=new.sales_channel,sold_on=new.sold_on,
      sold_price=null,payout_amount=null
    where accessory.is_accessory and accessory.lot_seq=new.lot_seq
      and app.product_serial(accessory.sku,accessory.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  end if;
  return new;
end;
$$;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after update of status,packed_on,shipped_on,returned_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.sync_accessory_sale_date();
notify pgrst,'reload schema';

-- ▼▼▼ 20261005025406_marketplace_purchase_drafts.sql ▼▼▼

create table if not exists app.marketplace_purchase_drafts (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  marketplace_item_id text not null,
  marketplace_url text not null,
  account_label text not null,
  title text not null,
  purchased_at date,
  cost_amount bigint,
  state text not null default 'draft' check (state in ('draft','registered','dismissed')),
  registered_item_id uuid references app.items(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (marketplace, marketplace_item_id)
);

alter table app.items add column if not exists source_purchase_draft_id uuid
  references app.marketplace_purchase_drafts(id) on delete set null;
create unique index if not exists items_source_purchase_draft_unique
  on app.items(source_purchase_draft_id) where source_purchase_draft_id is not null;

alter table app.marketplace_purchase_drafts enable row level security;
revoke all on app.marketplace_purchase_drafts from anon, authenticated;
grant select, update on app.marketplace_purchase_drafts to authenticated;
drop policy if exists marketplace_purchase_drafts_admin_read on app.marketplace_purchase_drafts;
create policy marketplace_purchase_drafts_admin_read on app.marketplace_purchase_drafts
  for select to authenticated using (app.is_admin());
drop policy if exists marketplace_purchase_drafts_admin_update on app.marketplace_purchase_drafts;
create policy marketplace_purchase_drafts_admin_update on app.marketplace_purchase_drafts
  for update to authenticated using (app.is_admin()) with check (app.is_admin());

create or replace function app.extension_sync_purchase_drafts(
  p_marketplace text, p_account_label text, p_purchases jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  inserted_count integer := 0;
  refreshed_count integer := 0;
  v_id text;
  v_title text;
  v_url text;
  v_price bigint;
  v_date date;
  was_inserted boolean;
  v_existing_item uuid;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_account_label),'') is null or length(p_account_label)>120 then raise exception 'アカウント名が不正です'; end if;
  if jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then raise exception '購入履歴の形式または件数が不正です'; end if;
  for row_data in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(row_data->>'marketplace_item_id'),'');
    v_title := nullif(btrim(row_data->>'title'),'');
    v_url := nullif(btrim(row_data->>'marketplace_url'),'');
    if v_id is null or v_title is null or v_url is null or length(v_id)>200 or length(v_title)>500 or length(v_url)>2000 then continue; end if;
    if (p_marketplace='メルカリ' and v_url !~ '^https://jp\.mercari\.com/')
      or (p_marketplace='ヤフオク' and v_url !~ '^https://(auctions|contact\.auctions|buy\.auctions)\.yahoo\.co\.jp/')
      or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_url !~ '^https://paypayfleamarket\.yahoo\.co\.jp/')
      or (p_marketplace='ラクマ' and v_url !~ '^https://(www\.)?fril\.jp/') then continue; end if;
    v_existing_item := null;
    select i.id into v_existing_item from app.items i
      where i.marketplace_item_id=v_id
        and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
      order by i.created_at desc limit 1;
    if v_existing_item is not null then
      insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,state,registered_item_id)
        values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,
          case when coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then (row_data->>'purchased_at')::date else null end,
          case when coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then (row_data->>'cost_amount')::bigint else null end,
          'registered',v_existing_item)
        on conflict(marketplace,marketplace_item_id) do nothing;
      continue;
    end if;
    v_price := null;
    if coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then v_price := (row_data->>'cost_amount')::bigint; end if;
    v_date := null;
    if coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then v_date := (row_data->>'purchased_at')::date; end if;
    insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount)
      values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,v_date,v_price)
      on conflict(marketplace,marketplace_item_id) do update set
        marketplace_url=excluded.marketplace_url,
        account_label=excluded.account_label,
        title=excluded.title,
        purchased_at=coalesce(excluded.purchased_at,app.marketplace_purchase_drafts.purchased_at),
        cost_amount=coalesce(excluded.cost_amount,app.marketplace_purchase_drafts.cost_amount),
        last_seen_at=now()
      where app.marketplace_purchase_drafts.state='draft'
      returning (xmax=0) into was_inserted;
    if found then
      if was_inserted then inserted_count := inserted_count+1;
      else refreshed_count := refreshed_count+1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'refreshed',refreshed_count);
end $$;
revoke all on function app.extension_sync_purchase_drafts(text,text,jsonb) from public, anon;
grant execute on function app.extension_sync_purchase_drafts(text,text,jsonb) to authenticated;

create or replace function app.mark_purchase_draft_registered()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source_purchase_draft_id is not null then
    update app.marketplace_purchase_drafts set state='registered',registered_item_id=new.id
      where id=new.source_purchase_draft_id and state='draft';
    if not found then raise exception '仕入れリストが既に反映済みか、削除されています'; end if;
  end if;
  return new;
end $$;
drop trigger if exists items_mark_purchase_draft_registered on app.items;
create trigger items_mark_purchase_draft_registered after insert on app.items
  for each row execute function app.mark_purchase_draft_registered();

comment on table app.marketplace_purchase_drafts is 'Chrome拡張機能で同期したフリマ購入履歴の下書き。仕入れリスト画面で確認してから在庫へ反映する。';


-- ▼▼▼ 20261005031305_marketplace_transaction_messages.sql ▼▼▼

create table if not exists app.marketplace_messages (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  marketplace_item_id text not null,
  item_id uuid references app.items(id) on delete cascade,
  external_id text not null,
  author text,
  author_role text not null default 'unknown' check (author_role in ('self','other','unknown')),
  body text not null check (length(body) between 1 and 10000),
  sent_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (marketplace, marketplace_item_id, external_id)
);
create index if not exists marketplace_messages_thread_idx
  on app.marketplace_messages(item_id, sent_at, id);
alter table app.marketplace_messages enable row level security;
revoke all on app.marketplace_messages from anon, authenticated;
grant select, insert, update on app.marketplace_messages to authenticated;
drop policy if exists marketplace_messages_read on app.marketplace_messages;
create policy marketplace_messages_read on app.marketplace_messages for select to authenticated
using (exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_messages_admin_write on app.marketplace_messages;
create policy marketplace_messages_admin_write on app.marketplace_messages for all to authenticated
using (app.is_admin()) with check (app.is_admin());

create table if not exists app.marketplace_message_outbox (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.items(id) on delete cascade,
  marketplace text not null,
  marketplace_item_id text not null,
  body text not null check (length(body) between 1 and 2000),
  requested_by uuid not null references auth.users(id),
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','uncertain')),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  sent_at timestamptz,
  result_note text
);
create index if not exists marketplace_message_outbox_queue_idx
  on app.marketplace_message_outbox(status, requested_at);
alter table app.marketplace_message_outbox enable row level security;
revoke all on app.marketplace_message_outbox from anon, authenticated;
grant select, insert, update on app.marketplace_message_outbox to authenticated;
drop policy if exists marketplace_message_outbox_read on app.marketplace_message_outbox;
create policy marketplace_message_outbox_read on app.marketplace_message_outbox for select to authenticated
using (requested_by=auth.uid() or app.is_admin() or app.current_role()='purchaser');
drop policy if exists marketplace_message_outbox_insert on app.marketplace_message_outbox;
create policy marketplace_message_outbox_insert on app.marketplace_message_outbox for insert to authenticated
with check (requested_by=auth.uid() and exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_message_outbox_admin_update on app.marketplace_message_outbox;
create policy marketplace_message_outbox_admin_update on app.marketplace_message_outbox for update to authenticated
using (app.is_admin()) with check (app.is_admin());

create or replace function app.read_marketplace_messages(p_item_id uuid)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare v_item app.items%rowtype;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  select * into v_item from app.items where id=p_item_id;
  if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then
    raise exception 'この商品の取引メッセージを閲覧する権限がありません' using errcode='42501';
  end if;
  return jsonb_build_object(
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author',m.author,'author_role',m.author_role,'body',m.body,'sent_at',m.sent_at) order by m.sent_at nulls first,m.id)
      from app.marketplace_messages m where m.item_id=p_item_id),'[]'::jsonb),
    'outbox', coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'body',o.body,'status',o.status,'requested_at',o.requested_at,'sent_at',o.sent_at,'result_note',o.result_note) order by o.requested_at desc)
      from app.marketplace_message_outbox o where o.item_id=p_item_id and o.requested_by=auth.uid()),'[]'::jsonb)
  );
end; $$;

create or replace function app.queue_marketplace_message(p_item_id uuid,p_body text)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare v_item app.items%rowtype; v_market text; v_outbox_id uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  if length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'メッセージは1〜2000文字で入力してください'; end if;
  select * into v_item from app.items where id=p_item_id;
  if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then
    raise exception 'この商品の取引メッセージを送信する権限がありません' using errcode='42501';
  end if;
  if nullif(btrim(v_item.marketplace_item_id),'') is null then raise exception '取引IDが登録されていません'; end if;
  v_market:=v_item.marketplace::text;
  if v_market not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception 'この仕入先は取引メッセージ連携の対象外です'; end if;
  if exists(select 1 from app.marketplace_message_outbox where item_id=v_item.id and status in ('queued','sending')) then
    raise exception 'この商品の前の送信依頼が処理中です。結果を確認してから送信してください';
  end if;
  insert into app.marketplace_message_outbox(item_id,marketplace,marketplace_item_id,body,requested_by)
    values(v_item.id,v_market,v_item.marketplace_item_id,btrim(p_body),auth.uid()) returning id into strict v_outbox_id;
  return v_outbox_id;
end; $$;

create or replace function app.extension_marketplace_message_queue(p_marketplaces text[])
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'item_id',item_id,'marketplace',marketplace,'marketplace_item_id',marketplace_item_id,'body',body) order by requested_at)
    from app.marketplace_message_outbox where status='queued' and requested_at > now()-interval '7 days' and marketplace=any(p_marketplaces)),'[]'::jsonb);
end; $$;

create or replace function app.extension_claim_marketplace_message(p_id uuid,p_claimant text)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare changed integer;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  update app.marketplace_message_outbox set status='sending',claimed_at=now(),claimed_by=left(coalesce(p_claimant,''),120),result_note=null
   where id=p_id and (status='queued' or (status='sending' and claimed_at < now()-interval '10 minutes'));
  get diagnostics changed=row_count;
  return changed=1;
end; $$;

create or replace function app.extension_finish_marketplace_message(p_id uuid,p_status text,p_note text default null)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare changed integer;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  if p_status not in ('sent','failed','uncertain') then raise exception '送信結果が不正です'; end if;
  update app.marketplace_message_outbox set status=p_status,sent_at=case when p_status='sent' then now() else null end,result_note=left(p_note,500)
   where id=p_id and status='sending';
  get diagnostics changed=row_count;
  return changed=1;
end; $$;

create or replace function app.extension_sync_marketplace_messages(p_marketplace text,p_item_id text,p_account_label text,p_messages jsonb)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare linked_id uuid; affected integer; matched integer;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or length(p_item_id)>160 then raise exception '取引を特定できません'; end if;
  select count(*) into matched from app.items where marketplace_item_id=p_item_id and
   (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ'));
  if matched>1 then raise exception '同じ取引IDの商品が複数あり、メッセージを結び付けられません'; end if;
  if matched=1 then select id into linked_id from app.items where marketplace_item_id=p_item_id and
   (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ')); end if;
  if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>500 then raise exception '取引メッセージの形式が不正です'; end if;
  insert into app.marketplace_messages(marketplace,marketplace_item_id,item_id,external_id,author,author_role,body,sent_at)
  select p_marketplace,p_item_id,linked_id,entry->>'external_id',nullif(left(entry->>'author',200),''),
    case when entry->>'author_role' in ('self','other') then entry->>'author_role' else 'unknown' end,
    left(entry->>'body',10000),nullif(entry->>'sent_at','')::timestamptz
  from jsonb_array_elements(p_messages) entry
  where coalesce(entry->>'external_id','')<>'' and coalesce(entry->>'body','')<>''
  on conflict(marketplace,marketplace_item_id,external_id) do update set item_id=excluded.item_id,author=excluded.author,author_role=excluded.author_role,body=excluded.body,sent_at=coalesce(excluded.sent_at,app.marketplace_messages.sent_at),synced_at=now();
  get diagnostics affected=row_count;
  return affected;
end; $$;

grant execute on function app.read_marketplace_messages(uuid) to authenticated;
grant execute on function app.queue_marketplace_message(uuid,text) to authenticated;
grant execute on function app.extension_marketplace_message_queue(text[]) to authenticated;
grant execute on function app.extension_claim_marketplace_message(uuid,text) to authenticated;
grant execute on function app.extension_finish_marketplace_message(uuid,text,text) to authenticated;
grant execute on function app.extension_sync_marketplace_messages(text,text,text,jsonb) to authenticated;


-- ▼▼▼ 20261005031318_allow_spare_deletion.sql ▼▼▼

grant delete on app.spare_accessories to authenticated;
drop policy if exists spare_accessories_delete on app.spare_accessories;
create policy spare_accessories_delete on app.spare_accessories
  for delete to authenticated
  using (
    used_for_item_id is null
    and source_sheet_row is null
    and (app.is_admin() or owner_staff_id = app.current_staff_id())
  );


-- ▼▼▼ 20261005034232_delivery_inventory_status_filters.sql ▼▼▼

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  case when i.is_accessory then shared.sales_channel else i.sales_channel end as sales_channel,
  i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id=i.product_id
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','返品処理','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;


-- ▼▼▼ 20261005065229_allow_deletion_of_unassigned_spares.sql ▼▼▼

drop policy if exists spare_accessories_delete on app.spare_accessories;
create policy spare_accessories_delete on app.spare_accessories
  for delete to authenticated
  using (
    used_for_item_id is null
    and (app.is_admin() or owner_staff_id = app.current_staff_id())
  );


-- ▼▼▼ 20261005124842_inventory_amazon_image_asin_fallback.sql ▼▼▼

create or replace view app.v_inventory_display with (security_invoker = true) as
with totals as materialized (
  select app.product_serial(i.sku, i.lot_seq) as serial_key,
    sum(i.refund_amount) as refunds,
    sum(i.inventory_refund_amount) as inventory_refunds,
    sum(i.shipping_cost) as shipping,
    sum(i.other_cost) as other_cost
  from app.items i
  group by app.product_serial(i.sku, i.lot_seq)
)
select inventory.*, raw.product_id, product.product_no,
  coalesce(nullif(btrim(product.image_url), ''), nullif(btrim(asin_product.image_url), '')) as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds + totals.inventory_refunds
      - inventory.product_cost - totals.shipping - totals.other_cost end as product_profit,
  raw.inventory_refund_amount
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join app.products asin_product on asin_product.asin=raw.asin
left join totals on totals.serial_key=app.product_serial(raw.sku,raw.lot_seq)
left join lateral (
  select body from app.item_comments
  where item_id=inventory.id
  order by created_at desc,id desc
  limit 1
) latest on true;

grant select on app.v_inventory_display to authenticated;


-- ▼▼▼ 20261005140000_stop_purchase_sync_at_inventory_match.sql ▼▼▼

create function app.extension_sync_purchase_drafts(
  p_marketplace text, p_account_label text, p_purchases jsonb, p_stop_on_match boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  inserted_count integer := 0;
  refreshed_count integer := 0;
  matched_item_ids text[] := array[]::text[];
  v_id text;
  v_title text;
  v_url text;
  v_price bigint;
  v_date date;
  was_inserted boolean;
  v_existing_item uuid;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_account_label),'') is null or length(p_account_label)>120 then raise exception 'アカウント名が不正です'; end if;
  if jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then raise exception '購入履歴の形式または件数が不正です'; end if;
  for row_data in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(row_data->>'marketplace_item_id'),'');
    v_title := nullif(btrim(row_data->>'title'),'');
    v_url := nullif(btrim(row_data->>'marketplace_url'),'');
    if v_id is null or v_title is null or v_url is null or length(v_id)>200 or length(v_title)>500 or length(v_url)>2000 then continue; end if;
    if (p_marketplace='メルカリ' and v_url !~ '^https://jp\.mercari\.com/')
      or (p_marketplace='ヤフオク' and v_url !~ '^https://(auctions|contact\.auctions|buy\.auctions)\.yahoo\.co\.jp/')
      or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_url !~ '^https://paypayfleamarket\.yahoo\.co\.jp/')
      or (p_marketplace='ラクマ' and v_url !~ '^https://(www\.)?fril\.jp/') then continue; end if;

    select i.id into v_existing_item from app.items i
      where i.marketplace_item_id=v_id
        and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
      order by i.created_at desc limit 1;
    if v_existing_item is not null then
      insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,state,registered_item_id)
        values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,
          case when coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then (row_data->>'purchased_at')::date else null end,
          case when coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then (row_data->>'cost_amount')::bigint else null end,
          'registered',v_existing_item)
        on conflict(marketplace,marketplace_item_id) do nothing;
      matched_item_ids := array_append(matched_item_ids,v_id);
      if p_stop_on_match then exit; end if;
      continue;
    end if;

    v_price := null;
    if coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then v_price := (row_data->>'cost_amount')::bigint; end if;
    v_date := null;
    if coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then v_date := (row_data->>'purchased_at')::date; end if;
    insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount)
      values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,v_date,v_price)
      on conflict(marketplace,marketplace_item_id) do update set
        marketplace_url=excluded.marketplace_url,
        account_label=excluded.account_label,
        title=excluded.title,
        purchased_at=coalesce(excluded.purchased_at,app.marketplace_purchase_drafts.purchased_at),
        cost_amount=coalesce(excluded.cost_amount,app.marketplace_purchase_drafts.cost_amount),
        last_seen_at=now()
      where app.marketplace_purchase_drafts.state='draft'
      returning (xmax=0) into was_inserted;
    if found then
      if was_inserted then inserted_count := inserted_count+1;
      else refreshed_count := refreshed_count+1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'refreshed',refreshed_count,'matched_item_ids',to_jsonb(matched_item_ids));
end $$;

revoke all on function app.extension_sync_purchase_drafts(text,text,jsonb,boolean) from public, anon;
grant execute on function app.extension_sync_purchase_drafts(text,text,jsonb,boolean) to authenticated;
create or replace function app.extension_sync_purchase_drafts(
  p_marketplace text,p_account_label text,p_purchases jsonb
)
returns jsonb language sql security definer set search_path = '' as $$
  select app.extension_sync_purchase_drafts(p_marketplace,p_account_label,p_purchases,false);
$$;
revoke all on function app.extension_sync_purchase_drafts(text,text,jsonb) from public, anon;
grant execute on function app.extension_sync_purchase_drafts(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261005141543_enrich_marketplace_purchase_drafts.sql ▼▼▼

alter table app.marketplace_purchase_drafts
  add column if not exists product_id uuid references app.products(id) on delete set null,
  add column if not exists model_no text,
  add column if not exists product_no integer,
  add column if not exists asin char(10),
  add column if not exists planned_price bigint,
  add column if not exists planned_payout bigint;

create or replace function app.extension_probe_purchase_item(
  p_marketplace text, p_marketplace_item_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_marketplace_item_id),'') is null or length(p_marketplace_item_id)>200 then raise exception '商品IDが不正です'; end if;
  select count(*) into v_count from app.items i
    where i.marketplace_item_id=btrim(p_marketplace_item_id)
      and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')));
  return jsonb_build_object('matched',v_count>0,'count',v_count);
end $$;
revoke all on function app.extension_probe_purchase_item(text,text) from public, anon;
grant execute on function app.extension_probe_purchase_item(text,text) to authenticated;

create or replace function app.extension_sync_purchase_drafts(
  p_marketplace text, p_account_label text, p_purchases jsonb, p_stop_on_match boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  inserted_count integer := 0;
  refreshed_count integer := 0;
  matched_item_ids text[] := array[]::text[];
  v_id text;
  v_title text;
  v_url text;
  v_price bigint;
  v_date date;
  v_model_no text;
  v_product_id uuid;
  v_product_no integer;
  v_asin char(10);
  v_planned_price bigint;
  v_planned_payout bigint;
  v_best_model_length integer;
  v_best_model_count integer;
  was_inserted boolean;
  v_existing_item uuid;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_account_label),'') is null or length(p_account_label)>120 then raise exception 'アカウント名が不正です'; end if;
  if jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then raise exception '購入履歴の形式または件数が不正です'; end if;
  for row_data in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(row_data->>'marketplace_item_id'),'');
    v_title := nullif(btrim(row_data->>'title'),'');
    v_url := nullif(btrim(row_data->>'marketplace_url'),'');
    if v_id is null or v_title is null or v_url is null or length(v_id)>200 or length(v_title)>500 or length(v_url)>2000 then continue; end if;
    if (p_marketplace='メルカリ' and v_url !~ '^https://jp\.mercari\.com/')
      or (p_marketplace='ヤフオク' and v_url !~ '^https://(auctions|page\.auctions|contact\.auctions|buy\.auctions)\.yahoo\.co\.jp/')
      or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_url !~ '^https://paypayfleamarket(-sec)?\.yahoo\.co\.jp/')
      or (p_marketplace='ラクマ' and v_url !~ '^https://(www\.)?fril\.jp/' and v_url !~ '^https://item\.fril\.jp/') then continue; end if;

    v_product_id := null; v_model_no := null; v_product_no := null; v_asin := null;
    v_planned_price := null; v_planned_payout := null; v_best_model_length := null; v_best_model_count := 0;
    select max(length(btrim(p.model_no))) into v_best_model_length
      from app.products p
      where p.is_active and nullif(btrim(p.model_no),'') is not null
        and position(lower(btrim(p.model_no)) in lower(v_title))>0;
    if v_best_model_length is not null then
      select count(*) into v_best_model_count from app.products p
        where p.is_active and nullif(btrim(p.model_no),'') is not null
          and length(btrim(p.model_no))=v_best_model_length
          and position(lower(btrim(p.model_no)) in lower(v_title))>0;
      if v_best_model_count=1 then
        select p.id,p.model_no,p.product_no,p.asin,p.list_price,p.payout_estimate
          into v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout
          from app.products p
          where p.is_active and nullif(btrim(p.model_no),'') is not null
            and length(btrim(p.model_no))=v_best_model_length
            and position(lower(btrim(p.model_no)) in lower(v_title))>0
          limit 1;
      end if;
    end if;

    select i.id into v_existing_item from app.items i
      where i.marketplace_item_id=v_id
        and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
      order by i.created_at desc limit 1;
    if v_existing_item is not null then
      insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,state,registered_item_id,product_id,model_no,product_no,asin,planned_price,planned_payout)
        values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,
          case when coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then (row_data->>'purchased_at')::date else null end,
          case when coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then (row_data->>'cost_amount')::bigint else null end,
          'registered',v_existing_item,v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout)
        on conflict(marketplace,marketplace_item_id) do nothing;
      matched_item_ids := array_append(matched_item_ids,v_id);
      if p_stop_on_match then exit; end if;
      continue;
    end if;

    v_price := null;
    if coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then v_price := (row_data->>'cost_amount')::bigint; end if;
    v_date := null;
    if coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then v_date := (row_data->>'purchased_at')::date; end if;
    insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,product_id,model_no,product_no,asin,planned_price,planned_payout)
      values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,v_date,v_price,v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout)
      on conflict(marketplace,marketplace_item_id) do update set
        marketplace_url=excluded.marketplace_url,
        account_label=excluded.account_label,
        title=excluded.title,
        purchased_at=coalesce(excluded.purchased_at,app.marketplace_purchase_drafts.purchased_at),
        cost_amount=coalesce(excluded.cost_amount,app.marketplace_purchase_drafts.cost_amount),
        product_id=coalesce(excluded.product_id,app.marketplace_purchase_drafts.product_id),
        model_no=coalesce(excluded.model_no,app.marketplace_purchase_drafts.model_no),
        product_no=coalesce(excluded.product_no,app.marketplace_purchase_drafts.product_no),
        asin=coalesce(excluded.asin,app.marketplace_purchase_drafts.asin),
        planned_price=coalesce(excluded.planned_price,app.marketplace_purchase_drafts.planned_price),
        planned_payout=coalesce(excluded.planned_payout,app.marketplace_purchase_drafts.planned_payout),
        last_seen_at=now()
      where app.marketplace_purchase_drafts.state='draft'
      returning (xmax=0) into was_inserted;
    if found then
      if was_inserted then inserted_count := inserted_count+1;
      else refreshed_count := refreshed_count+1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'refreshed',refreshed_count,'matched_item_ids',to_jsonb(matched_item_ids));
end $$;
revoke all on function app.extension_sync_purchase_drafts(text,text,jsonb,boolean) from public, anon;
grant execute on function app.extension_sync_purchase_drafts(text,text,jsonb,boolean) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261006022832_allow_sold_main_without_price.sql ▼▼▼

-- A sold item must retain its sale date, but its sale amount may be unknown.
-- This allows classifying a sold accessory row as a main item without inventing a price.
alter table app.items drop constraint if exists items_sold_requires_date;
alter table app.items add constraint items_sold_requires_date check (
  status <> '販売済' or sold_on is not null
);

-- ▼▼▼ 20261006023834_allow_blank_sale_details_and_correct_1a_classification.sql ▼▼▼

alter table app.items drop constraint if exists items_sold_requires_date;
alter table app.items disable trigger items_single_product_sale;
alter table app.items disable trigger items_sync_accessory_sale_date;
do $$
declare updated_count integer;
begin
  -- Fresh installations have no historical rows to correct.
  if not exists (select 1 from app.items) then return; end if;
  update app.items i
     set is_accessory = false, sold_on = v.sold_on, sold_price = v.sold_price, payout_amount = v.payout_amount
    from (values
    ('c5577d24-a126-4709-a552-2b792a19b917'::uuid,'2025-02-08'::date,21980,19327),
    ('d9cb0610-144b-4b89-9f2d-65ae224e8a1e'::uuid,'2025-04-27'::date,6680,4962),
    ('8d006fc1-42d0-4f81-92ba-66a574ee06d9'::uuid,'2025-03-27'::date,18900,17237),
    ('c0d0e4f9-9578-4ef2-a4f5-ddc3c81e336d'::uuid,'2025-02-10'::date,7000,5765),
    ('b865fcb6-ff0c-49b2-9292-de27ce98c1ec'::uuid,'2025-02-13'::date,15500,13361),
    ('035e4477-e96e-46d7-a2e5-9baaa0d2804c'::uuid,'2025-04-03'::date,6980,6212),
    ('853c9059-e98c-4b7b-9467-0fbf0ce58e17'::uuid,'2025-02-09'::date,16980,14092),
    ('732aca09-7014-41c6-b09c-43db77f0d15d'::uuid,'2025-02-16'::date,14500,12420),
    ('c20a6529-3d6e-461a-8705-c0e337f6011b'::uuid,null,null,null),
    ('bd96ec21-5417-4698-bd98-7174fdf18de7'::uuid,'2025-03-04'::date,6980,5397),
    ('f3e7f454-d722-44b5-a8d9-7f19a7bb6b49'::uuid,'2025-02-06'::date,29907,23296),
    ('09c62409-2ecb-4dd8-9918-bcbc01701e99'::uuid,'2025-02-26'::date,25480,22804),
    ('ce258441-9437-4e9f-aa41-5d3d41237bcc'::uuid,null,null,null),
    ('f163f54f-286c-47f1-9c2b-600cd173f32c'::uuid,null,null,null),
    ('d6a9ed9a-2c53-4fb8-ad24-0b71286a22ca'::uuid,null,null,null),
    ('3b382920-539b-41e4-b09f-be1a31eec507'::uuid,'2025-03-22'::date,3500,2300),
    ('af669ec6-9628-4d4c-9a92-bc081741d9cc'::uuid,'2025-02-25'::date,16398,13247),
    ('4a674b64-d915-4dd5-be11-02955f835bf8'::uuid,'2025-02-24'::date,26800,23338),
    ('83a2476d-d15b-47c3-8890-86fc3513b1c0'::uuid,'2025-03-01'::date,7970,6803),
    ('0c83b13b-d98f-472c-ba26-efd89ff44dbd'::uuid,'2025-02-15'::date,21980,19048),
    ('b5221101-efbc-4331-a884-7d6d4f78308a'::uuid,'2025-04-04'::date,19480,17337),
    ('06c89878-1e9e-439e-81ee-36c41228bd2d'::uuid,'2025-02-15'::date,9980,8287),
    ('54edb64b-437c-4a2d-a15f-a8655f582107'::uuid,'2025-03-01'::date,16980,14092),
    ('10c7b8e4-f96b-4d58-9d02-1554ae6f65cd'::uuid,'2025-03-01'::date,16500,13665),
    ('b3f9f492-6ca3-4e0a-85de-b5108a5b793f'::uuid,'2025-03-06'::date,22470,19513),
    ('2553c429-49fa-4af8-87a0-b5f2723ad9ad'::uuid,'2025-03-01'::date,22480,19522),
    ('5bb3f471-18a4-4a0b-a2f6-b5cc54b2e804'::uuid,'2025-02-27'::date,16000,13945),
    ('56267ca2-c3e2-4b41-8274-b56c4b9ce3f2'::uuid,'2025-03-08'::date,24380,21213),
    ('74d2649f-9e23-43e3-a0ed-ed7a1f7a593f'::uuid,'2025-03-01'::date,24000,20875),
    ('4a4a6d8c-5316-478f-b254-62e302ce8e82'::uuid,'2025-03-24'::date,22980,19967),
    ('16af97e2-b07b-4497-8560-b2981390f601'::uuid,'2025-03-31'::date,20980,18187),
    ('ff825f70-202a-4bcb-b7b4-d06cea477c00'::uuid,'2025-03-19'::date,11980,9489),
    ('7dd45a49-f225-4ea4-89ef-cf505a017798'::uuid,'2025-03-16'::date,15127,12949),
    ('949dc228-0e7d-4849-932c-142585813c93'::uuid,'2025-03-17'::date,19900,17306),
    ('b80676ba-c953-4fba-9f7d-e0bea577f822'::uuid,null,null,null),
    ('6d789bdb-7f78-4345-847b-bf3189368a71'::uuid,'2025-03-16'::date,23480,20412),
    ('f353973b-edbd-4ee1-b24f-e7ab29aa4fd9'::uuid,null,null,null),
    ('6676ddd7-1a42-491d-84f6-07f0c83b7f34'::uuid,'2025-03-22'::date,4300,3415),
    ('84c3f7c9-ab33-4594-9350-0d84aeec7c1e'::uuid,'2025-03-22'::date,7044,5609),
    ('90fe60aa-ab0e-4184-a58d-de54d6c41567'::uuid,'2025-04-17'::date,13980,12075),
    ('c27d093b-891b-45d6-8de7-3cc42450a1a3'::uuid,null,null,null),
    ('164384bf-8d00-4a9a-a34f-7b590b57b325'::uuid,'2025-03-14'::date,18800,16331),
    ('df4bce2d-3401-4cd0-807e-81b3d0bba258'::uuid,'2025-03-09'::date,9280,7950),
    ('d81a06c8-bb8d-43c4-a156-60b1cc01027a'::uuid,'2025-03-04'::date,18800,17146),
    ('b381aed0-168d-4761-9b42-54f7341634af'::uuid,'2025-03-03'::date,18255,15328),
    ('362306c0-bdd0-4e2d-a30a-7a92d8830939'::uuid,'2025-03-10'::date,20780,18240),
    ('e684fedb-fa16-4b45-a347-9a52a7497e80'::uuid,'2025-04-03'::date,14980,12818)
    ) as v(id, sold_on, sold_price, payout_amount)
   where i.id = v.id and i.sku like '1a-%' and i.is_accessory = true;
  get diagnostics updated_count = row_count;
  if updated_count <> 47 then raise exception 'Expected 47 matched 1a rows; updated %', updated_count; end if;
end;
$$;
alter table app.items enable trigger items_single_product_sale;
alter table app.items enable trigger items_sync_accessory_sale_date;


-- ▼▼▼ 20261006060009_marketplace_message_results_visibility_and_expiry.sql ▼▼▼

-- Ensure the policy target exists when replaying migrations on a fresh database.
create table if not exists app.marketplace_message_sync_requests (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references app.items(id) on delete cascade,
 marketplace text not null, marketplace_item_id text not null, requested_by uuid not null references auth.users(id),
 status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
 requested_at timestamptz not null default now(), claimed_at timestamptz, claimed_by text, completed_at timestamptz, result_note text
);
alter table app.marketplace_message_sync_requests enable row level security;

drop policy if exists marketplace_message_outbox_read on app.marketplace_message_outbox;
create policy marketplace_message_outbox_read on app.marketplace_message_outbox for select to authenticated
using (exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_message_sync_read on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_read on app.marketplace_message_sync_requests for select to authenticated
using (exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));

create or replace function app.read_marketplace_messages(p_item_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare first_sent timestamptz; packed_at timestamptz;
begin
 if not exists(select 1 from app.items i where i.id=p_item_id and (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id()))
 then raise exception 'この商品の取引メッセージを表示する権限がありません' using errcode='42501'; end if;
 select min(o.sent_at) into first_sent from app.marketplace_message_outbox o where o.item_id=p_item_id and o.status='sent' and o.sent_at is not null;
 select i.packed_completed_at into packed_at from app.items i where i.id=p_item_id;
 if packed_at is not null and packed_at<=now()-interval '7 days' then
  return jsonb_build_object('messages','[]'::jsonb,'outbox','[]'::jsonb,'first_app_sent_at',first_sent,'sync',null,'expired',true);
 end if;
 return jsonb_build_object(
  'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author',m.author,'author_role',m.author_role,'body',m.body,'sent_at',m.sent_at) order by m.sent_at,m.id)
   from app.marketplace_messages m where m.item_id=p_item_id and first_sent is not null and m.author_role='other' and m.sent_at>=first_sent),'[]'::jsonb),
  'outbox',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'body',o.body,'status',o.status,'requested_at',o.requested_at,'sent_at',o.sent_at,'result_note',o.result_note) order by o.requested_at)
   from app.marketplace_message_outbox o where o.item_id=p_item_id),'[]'::jsonb),
  'first_app_sent_at',first_sent,
  'sync',(select jsonb_build_object('id',r.id,'status',r.status,'requested_at',r.requested_at,'completed_at',r.completed_at,'result_note',r.result_note) from app.marketplace_message_sync_requests r where r.item_id=p_item_id order by r.requested_at desc limit 1),
  'expired',false);
end; $$;

create or replace function app.queue_marketplace_message(p_item_id uuid,p_body text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_item app.items%rowtype; v_market text; v_outbox_id uuid;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'メッセージは1〜2000文字で入力してください'; end if;
 select * into v_item from app.items where id=p_item_id;
 if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then
  raise exception 'この商品の取引メッセージを送信する権限がありません' using errcode='42501';
 end if;
 if v_item.packed_completed_at is not null and v_item.packed_completed_at<=now()-interval '7 days' then raise exception '梱包完了から7日を過ぎているため、メッセージを送信できません'; end if;
 if nullif(btrim(v_item.marketplace_item_id),'') is null then raise exception '取引IDが登録されていません'; end if;
 v_market:=v_item.marketplace::text;
 if v_market not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception 'この仕入先は取引メッセージ連携の対象外です'; end if;
 if exists(select 1 from app.marketplace_message_outbox where item_id=v_item.id and status in ('queued','sending')) then
  raise exception 'この商品の前の送信依頼が処理中です。結果を確認してから送信してください';
 end if;
 insert into app.marketplace_message_outbox(item_id,marketplace,marketplace_item_id,body,requested_by)
  values(v_item.id,v_market,v_item.marketplace_item_id,btrim(p_body),auth.uid()) returning id into strict v_outbox_id;
 return v_outbox_id;
end; $$;

-- ▼▼▼ 20261006091747_yahoo_brand_template_photos.sql ▼▼▼

-- Define the table before extending its check on fresh installations.
create table if not exists app.item_comment_template_photos (
  id uuid primary key default gen_random_uuid(),
  task_kind text not null check (task_kind = 'Panasonic◯ヤフオク'),
  file_name text not null,
  mime_type text not null check (mime_type = 'image/jpeg'),
  photo_base64 text not null,
  sort_order smallint not null check (sort_order between 1 and 9),
  created_at timestamptz not null default now(),
  unique(task_kind, sort_order),
  check (length(photo_base64) > 0)
);

alter table app.item_comment_template_photos enable row level security;
alter table app.item_comment_template_photos
  drop constraint if exists item_comment_template_photos_task_kind_check;

alter table app.item_comment_template_photos
  add constraint item_comment_template_photos_task_kind_check
  check (task_kind in (
    'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
    'SONY◯ヤフオク', 'SONY×ヤフオク',
    'SHARP◯ヤフオク', 'SHARP×ヤフオク',
    'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク'
  ));


-- ▼▼▼ 20261006092254_allow_ten_yahoo_template_photos.sql ▼▼▼

alter table app.item_comment_template_photos
  drop constraint if exists item_comment_template_photos_sort_order_check;

alter table app.item_comment_template_photos
  add constraint item_comment_template_photos_sort_order_check
  check (sort_order between 1 and 10);


-- ▼▼▼ 20261006092731_yahoo_auction_other_task_kind.sql ▼▼▼

-- The check is replayed before the later reply-template migration.
alter table app.item_comments add column if not exists task_kind text;

alter table app.item_comments
  drop constraint if exists item_comments_task_kind_check;

alter table app.item_comments
  add constraint item_comments_task_kind_check
  check (
    task_kind is null or task_kind in (
      'Amazon販売', '仕入先確認',
      'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
      'SONY◯ヤフオク', 'SONY×ヤフオク',
      'SHARP◯ヤフオク', 'SHARP×ヤフオク',
      'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク',
      'ヤフオク その他'
    )
  );


-- ▼▼▼ 20261006100000_signed_amazon_refunds.sql ▼▼▼

alter table app.items drop constraint if exists items_refund_amount_check;
alter table app.items drop constraint if exists items_amazon_refund_amount_check;
alter table app.amazon_refund_matches drop constraint if exists amazon_refund_matches_amount_check;
alter table app.amazon_refund_matches
  add constraint amazon_refund_matches_amount_check
  check ((refund_kind = 'inventory' and amount >= 0) or refund_kind = 'amazon_refund');

create or replace function app.sync_refund_sources() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.refund_amount <> 0 and new.amazon_refund_amount = 0 and new.non_amazon_refund_amount = 0 then
      if new.refund_note ilike '%Amazon%' then
        new.amazon_refund_amount := new.refund_amount;
      elsif new.refund_amount < 0 then
        raise exception 'Negative refund amounts must be recorded as Amazon refunds';
      else
        new.non_amazon_refund_amount := new.refund_amount;
      end if;
    else
      new.refund_amount := new.amazon_refund_amount + new.non_amazon_refund_amount;
    end if;
  elsif new.amazon_refund_amount is distinct from old.amazon_refund_amount
     or new.non_amazon_refund_amount is distinct from old.non_amazon_refund_amount then
    new.refund_amount := new.amazon_refund_amount + new.non_amazon_refund_amount;
  elsif new.refund_amount is distinct from old.refund_amount then
    if new.refund_note ilike '%Amazon%' then
      new.amazon_refund_amount := new.refund_amount;
      new.non_amazon_refund_amount := 0;
    elsif new.refund_amount < 0 then
      raise exception 'Negative refund amounts must be recorded as Amazon refunds';
    else
      new.amazon_refund_amount := 0;
      new.non_amazon_refund_amount := new.refund_amount;
    end if;
  end if;
  return new;
end; $$;

create or replace function app.apply_amazon_refund(p_account text,p_transaction text,p_sku text,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 txn app.amazon_payment_transactions%rowtype;
 kind text;
 amount_value bigint;
 target app.items%rowtype;
 prior app.amazon_refund_matches%rowtype;
 delta bigint;
 root_serial text;
 matching_refunds integer;
begin
 if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
 select * into txn from app.amazon_payment_transactions where account_key=p_account and marketplace_id='A1VC38T7YXB528' and transaction_id=p_transaction;
 if not found or txn.status not in ('RELEASED','支払い実行済み') then return jsonb_build_object('status','review','reason','支払い実行済みのAmazon取引が見つかりません。'); end if;
 kind:=case when lower(coalesce(txn.transaction_type,'')) in ('inventory reimbursement','inventoryreimbursement','fba inventory reimbursement','fbainventoryreimbursement','fba_inventory_reimbursement','在庫の払い戻し','在庫払い戻し') then 'inventory'
            when lower(coalesce(txn.transaction_type,'')) in ('refund','返金') then 'amazon_refund' else null end;
 if kind is null then return jsonb_build_object('status','review','reason','対象外の取引種類です。'); end if;
 if (select count(*) from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku)<>1 then return jsonb_build_object('status','review','reason','SKUを取引内で一意に特定できません。'); end if;
 select case when kind='inventory' then abs((e->>'amount')::numeric)::bigint else (e->>'amount')::numeric::bigint end into amount_value
 from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$';
 if amount_value is null then return jsonb_build_object('status','review','reason','SKU別の返金額が円の整数として確認できません。'); end if;
 if kind='inventory' and amount_value<0 then return jsonb_build_object('status','review','reason','在庫の払い戻し金額が負数のため確認が必要です。'); end if;
 root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
 if root_serial is null then return jsonb_build_object('status','review','reason','Amazon SKUから通番号を読み取れません。'); end if;
 select count(*) into matching_refunds
 from app.amazon_payment_transactions t
 where t.account_key=p_account and t.marketplace_id=txn.marketplace_id
   and lower(coalesce(t.transaction_type,'')) in ('refund','返金')
   and t.status in ('RELEASED','支払い実行済み')
   and (t.posted_at,t.transaction_id)<=(txn.posted_at,txn.transaction_id)
   and exists (select 1 from jsonb_array_elements(t.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$');
 if matching_refunds>1 then
   select * into target from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial
   order by length(coalesce((regexp_match(app.product_serial(i.sku,i.lot_seq),'^[0-9]+([a-z]*)$'))[1],'')),app.product_serial(i.sku,i.lot_seq),i.sku
   offset matching_refunds-1 limit 1;
   if not found then return jsonb_build_object('status','review','reason','同じSKUの返品回数に対応する本体行がありません。SKU順の在庫を確認してください。'); end if;
 else
   select * into target from app.items where lower(sku)=lower(p_sku) and not is_accessory;
   if not found then
     select count(*) into matching_refunds from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial;
     if matching_refunds<>1 then return jsonb_build_object('status','review','reason','対応する在庫行を一意に特定できません。'); end if;
     select * into target from app.items i where not i.is_accessory and (regexp_match(i.sku,'^([0-9]+)'))[1]=root_serial;
   end if;
 end if;
 select * into prior from app.amazon_refund_matches where account_key=p_account and marketplace_id=txn.marketplace_id and transaction_id=p_transaction and sku=p_sku;
 if prior.amount is not null and prior.item_id<>target.id then return jsonb_build_object('status','review','reason','以前の反映先と今回のSKU順割当が異なるため、自動で移し替えません。管理者の確認が必要です。'); end if;
 delta:=amount_value-coalesce(prior.amount,0);
 if delta<>0 then
   if kind='inventory' then update app.items set inventory_refund_amount=greatest(inventory_refund_amount+delta,0) where id=target.id;
   else update app.items set amazon_refund_amount=amazon_refund_amount+delta where id=target.id;
   end if;
 end if;
 insert into app.amazon_refund_matches(account_key,marketplace_id,transaction_id,sku,item_id,refund_kind,amount,applied_by)
 values(p_account,txn.marketplace_id,p_transaction,p_sku,target.id,kind,amount_value,p_actor)
 on conflict(account_key,marketplace_id,transaction_id,sku) do update set item_id=excluded.item_id,refund_kind=excluded.refund_kind,amount=excluded.amount,applied_by=excluded.applied_by,applied_at=now();
 return jsonb_build_object('status',case when prior.amount is null then 'applied' when delta=0 then 'unchanged' else 'applied' end,'reason',case when kind='inventory' then '在庫の払い戻しを反映しました。' else 'Amazon返金金額を反映しました。' end,'amount',amount_value,'sku',p_sku,'item_id',target.id);
end $$;

revoke all on function app.apply_amazon_refund(text,text,text,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_refund(text,text,text,uuid) to service_role;
notify pgrst,'reload schema';


-- ▼▼▼ 20261006110000_marketplace_message_button_and_retention.sql ▼▼▼

alter table app.items add column if not exists packed_completed_at timestamptz;
update app.items set packed_completed_at=((packed_on + 1)::timestamp at time zone 'Asia/Tokyo' - interval '1 microsecond') where packed_on is not null and packed_completed_at is null;
create or replace function app.capture_packed_completion_time() returns trigger language plpgsql set search_path='' as $$
begin
 if new.packed_on is null then new.packed_completed_at:=null;
 elsif tg_op='INSERT' then new.packed_completed_at:=clock_timestamp();
 elsif old.packed_on is null or old.packed_completed_at is null then new.packed_completed_at:=clock_timestamp();
 else new.packed_completed_at:=old.packed_completed_at; end if;
 return new;
end; $$;
drop trigger if exists items_capture_packed_completion_time on app.items;
create trigger items_capture_packed_completion_time before insert or update of packed_on on app.items for each row execute function app.capture_packed_completion_time();
create index if not exists items_packed_completed_at_idx on app.items(packed_completed_at) where packed_completed_at is not null;

create table if not exists app.marketplace_message_sync_requests (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references app.items(id) on delete cascade,
 marketplace text not null, marketplace_item_id text not null, requested_by uuid not null references auth.users(id),
 status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
 requested_at timestamptz not null default now(), claimed_at timestamptz, claimed_by text, completed_at timestamptz, result_note text
);
create unique index if not exists marketplace_message_sync_active_item_idx on app.marketplace_message_sync_requests(item_id) where status in ('queued','processing');
create index if not exists marketplace_message_sync_queue_idx on app.marketplace_message_sync_requests(status,requested_at);
alter table app.marketplace_message_sync_requests enable row level security;
revoke all on app.marketplace_message_sync_requests from anon,authenticated;
grant select,insert,update on app.marketplace_message_sync_requests to authenticated;
drop policy if exists marketplace_message_sync_read on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_read on app.marketplace_message_sync_requests for select to authenticated using (requested_by=auth.uid() or app.is_admin() or app.current_role()='purchaser');
drop policy if exists marketplace_message_sync_insert on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_insert on app.marketplace_message_sync_requests for insert to authenticated with check (requested_by=auth.uid() and exists(select 1 from app.items i where i.id=app.marketplace_message_sync_requests.item_id and i.marketplace::text=app.marketplace_message_sync_requests.marketplace and i.marketplace_item_id=app.marketplace_message_sync_requests.marketplace_item_id and (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_message_sync_admin_update on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_admin_update on app.marketplace_message_sync_requests for all to authenticated using (app.is_admin()) with check (app.is_admin());

create or replace function app.read_marketplace_messages(p_item_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare first_sent timestamptz; packed_at timestamptz;
begin
 if not exists(select 1 from app.items i where i.id=p_item_id and (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id()))
 then raise exception 'この商品の取引メッセージを表示する権限がありません' using errcode='42501'; end if;
 select min(o.sent_at) into first_sent from app.marketplace_message_outbox o where o.item_id=p_item_id and o.status='sent' and o.sent_at is not null;
 select i.packed_completed_at into packed_at from app.items i where i.id=p_item_id;
 if packed_at is not null and packed_at<=now()-interval '7 days' then
  return jsonb_build_object('messages','[]'::jsonb,'outbox','[]'::jsonb,'first_app_sent_at',first_sent,'sync',null,'expired',true);
 end if;
 return jsonb_build_object(
  'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author',m.author,'author_role',m.author_role,'body',m.body,'sent_at',m.sent_at) order by m.sent_at,m.id)
   from app.marketplace_messages m where m.item_id=p_item_id and first_sent is not null and m.author_role='other' and m.sent_at>=first_sent),'[]'::jsonb),
  'outbox',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'body',o.body,'status',o.status,'requested_at',o.requested_at,'sent_at',o.sent_at,'result_note',o.result_note) order by o.requested_at)
   from app.marketplace_message_outbox o where o.item_id=p_item_id and o.requested_by=auth.uid()),'[]'::jsonb),
  'first_app_sent_at',first_sent,
  'sync',(select jsonb_build_object('id',r.id,'status',r.status,'requested_at',r.requested_at,'completed_at',r.completed_at,'result_note',r.result_note) from app.marketplace_message_sync_requests r where r.item_id=p_item_id and r.requested_by=auth.uid() order by r.requested_at desc limit 1),
  'expired',false);
end; $$;

create or replace function app.queue_marketplace_message_sync(p_item_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_item app.items%rowtype; first_sent timestamptz; request_id uuid;
begin
 select * into v_item from app.items where id=p_item_id;
 if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then raise exception 'この商品の取引メッセージを確認する権限がありません' using errcode='42501'; end if;
 if nullif(btrim(v_item.marketplace_item_id),'') is null then raise exception '取引IDが登録されていません'; end if;
 if v_item.marketplace::text not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception 'この仕入先は取引メッセージ連携の対象外です'; end if;
 if v_item.packed_completed_at is not null and v_item.packed_completed_at<=now()-interval '7 days' then raise exception '梱包完了から7日を過ぎているため、メッセージを確認できません'; end if;
 select min(sent_at) into first_sent from app.marketplace_message_outbox where item_id=p_item_id and status='sent' and sent_at is not null;
 if first_sent is null then raise exception '先にアプリから取引メッセージを送信してください'; end if;
 insert into app.marketplace_message_sync_requests(item_id,marketplace,marketplace_item_id,requested_by) values(p_item_id,v_item.marketplace::text,v_item.marketplace_item_id,auth.uid())
 on conflict(item_id) where status in ('queued','processing') do nothing returning id into request_id;
 if request_id is null then select id into request_id from app.marketplace_message_sync_requests where item_id=p_item_id and status in ('queued','processing') order by requested_at desc limit 1; end if;
 return request_id;
end; $$;

create or replace function app.extension_marketplace_message_sync_queue(p_marketplaces text[])
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'item_id',r.item_id,'marketplace',r.marketplace,'marketplace_item_id',r.marketplace_item_id) order by r.requested_at)
  from app.marketplace_message_sync_requests r join app.items i on i.id=r.item_id where (r.status='queued' or (r.status='processing' and r.claimed_at<now()-interval '10 minutes')) and r.marketplace=any(p_marketplaces)
   and (i.packed_completed_at is null or i.packed_completed_at>now()-interval '7 days')),'[]'::jsonb);
end; $$;
create or replace function app.extension_claim_marketplace_message_sync(p_id uuid,p_claimant text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 update app.marketplace_message_sync_requests set status='processing',claimed_at=now(),claimed_by=left(coalesce(p_claimant,''),120),result_note=null
 where id=p_id and (status='queued' or (status='processing' and claimed_at<now()-interval '10 minutes'));
 get diagnostics changed=row_count; return changed=1;
end; $$;
create or replace function app.extension_finish_marketplace_message_sync(p_id uuid,p_status text,p_note text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 if p_status not in ('completed','failed') then raise exception '同期結果が不正です'; end if;
 update app.marketplace_message_sync_requests set status=p_status,completed_at=now(),result_note=left(p_note,500) where id=p_id and status='processing';
 get diagnostics changed=row_count; return changed=1;
end; $$;

create or replace function app.extension_sync_marketplace_messages(p_marketplace text,p_item_id text,p_account_label text,p_messages jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare linked_id uuid; affected integer; matched integer; first_sent timestamptz;
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or length(p_item_id)>160 then raise exception '取引を特定できません'; end if;
 select count(*) into matched from app.items where marketplace_item_id=p_item_id and (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ'));
 if matched>1 then raise exception '同じ取引IDの商品が複数あり、メッセージを結び付けられません'; end if;
 if matched=1 then select id into linked_id from app.items where marketplace_item_id=p_item_id and (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ')); end if;
 if linked_id is null then raise exception 'アプリの在庫行に一致しません'; end if;
 select min(sent_at) into first_sent from app.marketplace_message_outbox where item_id=linked_id and status='sent' and sent_at is not null;
 if first_sent is null then raise exception 'アプリからの送信成功後だけ相手のメッセージを取り込めます'; end if;
 if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>500 then raise exception '取引メッセージの形式が不正です'; end if;
 insert into app.marketplace_messages(marketplace,marketplace_item_id,item_id,external_id,author,author_role,body,sent_at)
 select p_marketplace,p_item_id,linked_id,entry->>'external_id',nullif(left(entry->>'author',200),''),'other',left(entry->>'body',10000),nullif(entry->>'sent_at','')::timestamptz
 from jsonb_array_elements(p_messages) entry where coalesce(entry->>'external_id','')<>'' and coalesce(entry->>'body','')<>''
  and entry->>'author_role'='other' and nullif(entry->>'sent_at','')::timestamptz>=first_sent
 on conflict(marketplace,marketplace_item_id,external_id) do update set item_id=excluded.item_id,author=excluded.author,author_role=excluded.author_role,body=excluded.body,sent_at=coalesce(excluded.sent_at,app.marketplace_messages.sent_at),synced_at=now();
 get diagnostics affected=row_count; return affected;
end; $$;

create or replace function app.purge_expired_marketplace_messages()
returns void language plpgsql security definer set search_path='' as $$
begin
 delete from app.marketplace_messages m using app.items i where m.item_id=i.id and i.packed_completed_at is not null and i.packed_completed_at<=now()-interval '7 days';
 delete from app.marketplace_message_outbox o using app.items i where o.item_id=i.id and i.packed_completed_at is not null and i.packed_completed_at<=now()-interval '7 days';
 delete from app.marketplace_message_sync_requests r using app.items i where r.item_id=i.id and i.packed_completed_at is not null and i.packed_completed_at<=now()-interval '7 days';
end; $$;
revoke all on function app.purge_expired_marketplace_messages() from public,anon,authenticated;
grant execute on function app.purge_expired_marketplace_messages() to postgres;
create extension if not exists pg_cron with schema pg_catalog;
do $$ declare existing_job bigint; begin
 select jobid into existing_job from cron.job where jobname='marketplace-message-retention';
 if existing_job is not null then perform cron.unschedule(existing_job); end if;
 perform cron.schedule('marketplace-message-retention','*/15 * * * *','select app.purge_expired_marketplace_messages()');
end; $$;

grant execute on function app.read_marketplace_messages(uuid) to authenticated;
grant execute on function app.queue_marketplace_message_sync(uuid) to authenticated;
grant execute on function app.extension_marketplace_message_sync_queue(text[]) to authenticated;
grant execute on function app.extension_claim_marketplace_message_sync(uuid,text) to authenticated;
grant execute on function app.extension_finish_marketplace_message_sync(uuid,text,text) to authenticated;
grant execute on function app.extension_sync_marketplace_messages(text,text,text,jsonb) to authenticated;



-- ▼▼▼ 20261006141000_move_working_return_fnsku_to_tracking.sql ▼▼▼

-- Older working returns stored FNSKU in title. Preserve that source for older
-- clients while copying the identifier into its new field without overwriting
-- existing tracking values. Safe to run against an empty database or rerun.
update app.items
set tracking_no = btrim(title)
where marketplace::text = '動作品Amazon返品'
  and nullif(btrim(tracking_no), '') is null
  and btrim(title) ~ '^X[A-Z0-9]{9}$';


-- ▼▼▼ 20261006153345_lot_photo_folders.sql ▼▼▼

-- One canonical Google Drive folder per lot, independent of SKU/return rows.
create table app.lot_photo_folders (
  lot_seq bigint primary key,
  drive_folder_id text not null
);
alter table app.lot_photo_folders enable row level security;
revoke all on app.lot_photo_folders from anon, authenticated;
grant all on app.lot_photo_folders to service_role;

-- Reuse the oldest known folder. Files are consolidated on the next save;
-- old folders and photos are not deleted by this migration.
insert into app.lot_photo_folders (lot_seq, drive_folder_id)
select distinct on (i.lot_seq) i.lot_seq, r.drive_folder_id
from app.items i join app.photo_reviews r on r.item_id = i.id
where r.drive_folder_id is not null
order by i.lot_seq, r.submitted_at, i.id;


-- ▼▼▼ 20261006173000_malfunction_reply_templates_and_photos.sql ▼▼▼

alter table app.item_comments
  add column if not exists task_kind text,
  add column if not exists task_completed_at timestamptz,
  add column if not exists task_completed_by uuid references app.staff(id) on delete set null;

alter table app.item_comments drop constraint if exists item_comments_task_kind_check;
alter table app.item_comments add constraint item_comments_task_kind_check check (
  task_kind is null or task_kind in (
    'Amazon販売', '仕入先確認',
    'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
    'SONY◯ヤフオク', 'SONY×ヤフオク',
    'SHARP◯ヤフオク', 'SHARP×ヤフオク',
    'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク'
  )
);

create index if not exists item_comments_open_tasks_idx
  on app.item_comments(created_at desc) where task_kind is not null and task_completed_at is null;

create table if not exists app.item_comment_photos (
  id uuid primary key default gen_random_uuid(),
  item_comment_id uuid not null references app.item_comments(id) on delete cascade,
  item_id uuid not null references app.items(id) on delete cascade,
  storage_path text not null unique,
  sort_order smallint not null default 0 check (sort_order between 0 and 9),
  created_at timestamptz not null default now(),
  unique(item_comment_id, sort_order)
);

alter table app.item_comment_photos enable row level security;
grant select, insert on app.item_comment_photos to authenticated;
grant all on app.item_comment_photos to service_role;

drop policy if exists item_comment_photos_select on app.item_comment_photos;
create policy item_comment_photos_select on app.item_comment_photos
  for select to authenticated using (
    exists (
      select 1 from app.items i
      where i.id = item_id
        and (app.current_role() in ('admin','purchaser') or i.deliverer_id = app.current_staff_id())
    )
  );

drop policy if exists item_comment_photos_insert on app.item_comment_photos;
create policy item_comment_photos_insert on app.item_comment_photos
  for insert to authenticated with check (
    exists (
      select 1 from app.item_comments c join app.items i on i.id = c.item_id
      where c.id = item_comment_id and c.item_id = item_comment_photos.item_id
        and c.author_id = app.current_staff_id()
        and (app.current_role() in ('admin','purchaser') or i.deliverer_id = app.current_staff_id())
    )
  );

create or replace function app.complete_item_comment_task(p_comment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception 'タスク完了の権限がありません' using errcode = '42501';
  end if;
  update app.item_comments
    set task_completed_at = clock_timestamp(), task_completed_by = app.current_staff_id()
    where id = p_comment_id and task_kind is not null and task_completed_at is null;
  if not found and not exists (
    select 1 from app.item_comments where id = p_comment_id and task_kind is not null
  ) then
    raise exception '対象のタスクが見つかりません' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function app.complete_item_comment_task(uuid) from public, anon, authenticated;
grant execute on function app.complete_item_comment_task(uuid) to authenticated;


-- ▼▼▼ 20261006192853_task_notices_and_malfunction_replies.sql ▼▼▼

-- Reading an item acknowledges only the exact reply/approval that was displayed.
create table app.item_notice_reads (
  staff_id uuid not null references app.staff(id) on delete cascade,
  item_id uuid not null references app.items(id) on delete cascade,
  reply_read_at timestamptz,
  photo_read_at timestamptz,
  primary key (staff_id, item_id)
);
alter table app.item_notice_reads enable row level security;
revoke all on app.item_notice_reads from public, anon, authenticated;
grant select on app.item_notice_reads to authenticated;
grant all on app.item_notice_reads to service_role;
create policy item_notice_reads_self on app.item_notice_reads for select to authenticated
  using (staff_id = app.current_staff_id());

create function app.list_delivery_item_notices()
returns table(item_id uuid, lot_seq bigint, reply_at timestamptz, photo_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.lot_seq::bigint,
    case when c.last_reply > coalesce(r.reply_read_at, '-infinity'::timestamptz) then c.last_reply end,
    case when p.approved_at > coalesce(r.photo_read_at, '-infinity'::timestamptz) then p.approved_at end
  from app.items i
  left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=app.current_staff_id()
  left join app.photo_reviews p on p.item_id=i.id
  left join lateral (
    select max(cm.created_at) last_reply from app.item_comments cm
    join app.staff s on s.id=cm.author_id
    where cm.item_id=i.id and cm.created_at>i.malfunction_reported_at
      and cm.author_id<>app.current_staff_id() and s.role in ('admin','purchaser')
  ) c on true
  where auth.uid() is not null and app.current_staff_id() is not null and app.current_role() is not null
    and (app.is_admin() or i.deliverer_id=app.current_staff_id())
    and (c.last_reply > coalesce(r.reply_read_at, '-infinity'::timestamptz)
      or p.approved_at > coalesce(r.photo_read_at, '-infinity'::timestamptz));
$$;
revoke all on function app.list_delivery_item_notices() from public, anon;
grant execute on function app.list_delivery_item_notices() to authenticated;

create function app.mark_item_notices_read(p_item_id uuid, p_reply_through timestamptz default null, p_photo_through timestamptz default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or app.current_staff_id() is null or app.current_role() is null then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  perform app.assert_can_work_on(p_item_id);
  if p_reply_through is not null and not exists (
    select 1 from app.item_comments c join app.staff s on s.id=c.author_id
    join app.items i on i.id=c.item_id
    where c.item_id=p_item_id and c.created_at=p_reply_through
      and c.created_at>i.malfunction_reported_at and s.role in ('admin','purchaser')
      and c.author_id<>app.current_staff_id()
  ) then raise exception '返信通知が見つかりません' using errcode='22023'; end if;
  if p_photo_through is not null and not exists (
    select 1 from app.photo_reviews where item_id=p_item_id and approved_at=p_photo_through
  ) then raise exception '写真承認が更新されています。再読み込みしてください' using errcode='22023'; end if;
  insert into app.item_notice_reads(staff_id,item_id,reply_read_at,photo_read_at)
  values(app.current_staff_id(),p_item_id,p_reply_through,p_photo_through)
  on conflict(staff_id,item_id) do update set
    reply_read_at=greatest(app.item_notice_reads.reply_read_at,excluded.reply_read_at),
    photo_read_at=greatest(app.item_notice_reads.photo_read_at,excluded.photo_read_at);
end $$;
revoke all on function app.mark_item_notices_read(uuid,timestamptz,timestamptz) from public, anon;
grant execute on function app.mark_item_notices_read(uuid,timestamptz,timestamptz) to authenticated;

-- Own registered ID wins. Only an unambiguous original of the same returned product is a fallback.
create function app.resolve_task_product_id(p_item_id uuid)
returns text language sql stable security invoker set search_path='' as $$
  select coalesce(nullif(btrim(i.marketplace_item_id),''),
    case when i.marketplace::text='Amazon返品' and i.sku ~ '^[0-9]+[a-zA-Z]+-' and i.asin is not null then
      (select case when count(*)=1 then min(nullif(btrim(o.marketplace_item_id),'')) end
       from app.items o where o.lot_seq=i.lot_seq and o.asin=i.asin
         and not o.is_accessory and o.sku ~ '^[0-9]+-' and o.id<>i.id
         and nullif(btrim(o.marketplace_item_id),'') is not null)
    end)
  from app.items i where i.id=p_item_id;
$$;
revoke all on function app.resolve_task_product_id(uuid) from public, anon;
grant execute on function app.resolve_task_product_id(uuid) to authenticated;

create view app.v_item_action_tasks with (security_invoker=true) as
  select c.id,c.item_id,c.task_kind,c.task_completed_at,c.created_at,
    i.lot_seq,i.sku,app.resolve_task_product_id(i.id) as marketplace_item_id
  from app.item_comments c join app.items i on i.id=c.item_id
  where c.task_kind is not null;
revoke all on app.v_item_action_tasks from public, anon;
grant select on app.v_item_action_tasks to authenticated;

-- Channel transition and resolution are in the same transaction as the reply.
create function app.apply_malfunction_reply()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or new.author_id is distinct from app.current_staff_id()
    or not coalesce(app.current_role() in ('admin','purchaser'),false) then return new; end if;
  if app.current_role()='purchaser' and not exists (
    select 1 from app.items where id=new.item_id and purchaser_id=app.current_staff_id()
  ) then raise exception '担当外の商品には返信できません' using errcode='42501'; end if;
  if new.task_kind like '%ヤフオク%' then perform app.prepare_yahoo_auction_item(new.item_id); end if;
  update app.items set malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id
    where id=new.item_id and malfunction_reported and malfunction_resolved_at is null
      and new.created_at>malfunction_reported_at;
  return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public, anon, authenticated;
create trigger item_comments_apply_malfunction_reply after insert on app.item_comments
  for each row execute function app.apply_malfunction_reply();

create function app.send_malfunction_reply(p_comment_id uuid,p_item_id uuid,p_body text,p_task_kind text,p_photo_paths text[] default '{}')
returns void language plpgsql security definer set search_path='' as $$
declare v_sku text; v_existing app.item_comments%rowtype;
begin
  if auth.uid() is null or not coalesce(app.current_role() in ('admin','purchaser'),false) then
    raise exception '返信する権限がありません' using errcode='42501'; end if;
  select sku into v_sku from app.items where id=p_item_id and (app.is_admin() or purchaser_id=app.current_staff_id()) for update;
  if not found then raise exception '対象商品が見つかりません' using errcode='42501'; end if;
  if length(btrim(coalesce(p_body,'')))=0 or length(p_body)>2000 or coalesce(cardinality(p_photo_paths),0)>10 then
    raise exception '返信内容・写真枚数を確認してください' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_photo_paths) p where p is null or p not like v_sku||'/reply/'||p_comment_id::text||'/%') then
    raise exception '写真の対象商品が一致しません' using errcode='22023'; end if;
  select * into v_existing from app.item_comments where id=p_comment_id;
  if found then
    if v_existing.item_id=p_item_id and v_existing.author_id=app.current_staff_id() and v_existing.body=btrim(p_body)
      and v_existing.task_kind is not distinct from p_task_kind
      and coalesce((select array_agg(storage_path order by sort_order) from app.item_comment_photos where item_comment_id=p_comment_id),'{}'::text[])
        =coalesce(p_photo_paths,'{}'::text[]) then return; end if;
    raise exception '返信IDが重複しています' using errcode='22023';
  end if;
  insert into app.item_comments(id,item_id,author_id,body,task_kind)
    values(p_comment_id,p_item_id,app.current_staff_id(),btrim(p_body),p_task_kind);
  insert into app.item_comment_photos(item_comment_id,item_id,storage_path,sort_order)
    select p_comment_id,p_item_id,p,(n-1)::smallint from unnest(p_photo_paths) with ordinality as x(p,n);
end $$;
revoke all on function app.send_malfunction_reply(uuid,uuid,text,text,text[]) from public, anon;
grant execute on function app.send_malfunction_reply(uuid,uuid,text,text,text[]) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261006193000_yahoo_auction_preparation.sql ▼▼▼

create or replace function app.prepare_yahoo_auction_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body app.items%rowtype;
  v_remote app.items%rowtype;
  v_remote_count integer;
  v_owner_id uuid;
  v_owner_name text;
  v_model_no text;
  v_maker text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception 'ヤフオク販売の準備を行う権限がありません' using errcode='42501';
  end if;

  select * into v_body from app.items where id=p_item_id for update;
  if not found then raise exception '対象の在庫行が見つかりません' using errcode='P0002'; end if;
  if v_body.is_accessory then raise exception '本体の在庫行を選択してください' using errcode='22023'; end if;
  if app.current_role() = 'purchaser' and v_body.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外の商品はヤフオク販売に設定できません' using errcode='42501';
  end if;

  update app.items set sales_channel='ヤフオク'::app.sales_channel, updated_at=now() where id=v_body.id;

  if exists (
    select 1 from app.spare_accessories s
    where s.usage_note=v_body.lot_seq::text and s.title ilike '%リモコン%'
  ) then
    return;
  end if;

  select count(*) into v_remote_count from app.items i
  where i.lot_seq=v_body.lot_seq and i.is_accessory and i.title ilike '%リモコン%';
  if v_remote_count > 1 then
    raise exception '通番号 % のリモコン行が複数あります。在庫一覧を確認してください。', v_body.lot_seq using errcode='22023';
  end if;

  if v_remote_count = 1 then
    select * into v_remote from app.items i
    where i.lot_seq=v_body.lot_seq and i.is_accessory and i.title ilike '%リモコン%'
    limit 1 for update;
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_remote.product_id;
    v_owner_id := coalesce(v_remote.purchaser_id,v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    perform app.move_inventory_accessory_to_spares(v_remote.id,jsonb_build_object(
      'source_sku',v_remote.sku,
      'owner_staff_id',v_owner_id,
      'owner_name',v_owner_name,
      'purchased_at',v_remote.purchased_at,
      'title',v_remote.title,
      'manufacturer',v_maker,
      'model_no',v_model_no,
      'asin',v_remote.asin,
      'cost_amount',v_remote.cost_amount,
      'marketplace',v_remote.marketplace,
      'marketplace_item_id',v_remote.marketplace_item_id,
      'tracking_no',v_remote.tracking_no,
      'usage_note',v_body.lot_seq::text
    ));
  else
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_body.product_id;
    v_owner_id := coalesce(v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    insert into app.spare_accessories (
      source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
      cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
    ) values (
      null,v_owner_id,v_owner_name,v_body.purchased_at,'リモコン',v_maker,v_model_no,v_body.asin,
      0,v_body.marketplace,v_body.marketplace_item_id,v_body.tracking_no,v_body.lot_seq::text
    );
  end if;
end;
$$;

revoke all on function app.prepare_yahoo_auction_item(uuid) from public, anon;
grant execute on function app.prepare_yahoo_auction_item(uuid) to authenticated;


-- ▼▼▼ 20261006200000_panasonic_yahoo_template_photos.sql ▼▼▼

create table if not exists app.item_comment_template_photos (
  id uuid primary key default gen_random_uuid(),
  task_kind text not null check (task_kind = 'Panasonic◯ヤフオク'),
  file_name text not null,
  mime_type text not null check (mime_type = 'image/jpeg'),
  photo_base64 text not null,
  sort_order smallint not null check (sort_order between 1 and 9),
  created_at timestamptz not null default now(),
  unique(task_kind, sort_order),
  check (length(photo_base64) > 0)
);

alter table app.item_comment_template_photos enable row level security;
grant select on app.item_comment_template_photos to authenticated;
grant all on app.item_comment_template_photos to service_role;

drop policy if exists item_comment_template_photos_admin_select on app.item_comment_template_photos;
create policy item_comment_template_photos_admin_select
  on app.item_comment_template_photos for select to authenticated
  using (app.current_role() = 'admin');


-- ▼▼▼ 20261006210000_panasonic_x_yahoo_template_photos.sql ▼▼▼

alter table app.item_comment_template_photos
  drop constraint if exists item_comment_template_photos_task_kind_check;
alter table app.item_comment_template_photos
  add constraint item_comment_template_photos_task_kind_check
  check (task_kind in ('Panasonic◯ヤフオク', 'Panasonic×ヤフオク'));


-- ▼▼▼ 20261007002034_delivery_web_push.sql ▼▼▼

-- Future-only events; existing tasks are deliberately not backfilled.
create table app.delivery_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references app.staff(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  base_url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index delivery_push_subscriptions_staff_idx on app.delivery_push_subscriptions(staff_id);
create table app.delivery_push_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.items(id) on delete cascade,
  staff_id uuid not null references app.staff(id) on delete cascade,
  kind text not null check (kind in ('reply','photo','assigned')),
  event_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (item_id, staff_id, kind, event_at)
);
create index delivery_push_events_staff_idx on app.delivery_push_events(staff_id,created_at);
create table app.delivery_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references app.delivery_push_events(id) on delete cascade,
  subscription_id uuid not null references app.delivery_push_subscriptions(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','sending','sent','cancelled','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_status integer,
  unique(event_id,subscription_id)
);
create index delivery_push_deliveries_subscription_idx on app.delivery_push_deliveries(subscription_id);
create index delivery_push_deliveries_pending_idx on app.delivery_push_deliveries(next_attempt_at) where state in ('pending','sending');
alter table app.delivery_push_subscriptions enable row level security;
alter table app.delivery_push_events enable row level security;
alter table app.delivery_push_deliveries enable row level security;
revoke all on app.delivery_push_subscriptions,app.delivery_push_events,app.delivery_push_deliveries from public,anon,authenticated;
grant all on app.delivery_push_subscriptions,app.delivery_push_events,app.delivery_push_deliveries to service_role;

create function app.enqueue_delivery_push(p_item_id uuid,p_kind text,p_at timestamptz,p_actor uuid)
returns void language sql security definer set search_path='' as $$
  insert into app.delivery_push_events(item_id,staff_id,kind,event_at)
  select i.id,s.id,p_kind,p_at from app.items i join app.staff s
    on s.is_active and (s.role='admin' or (s.id=i.deliverer_id and s.role='deliverer'))
  where i.id=p_item_id and s.id is distinct from p_actor
  on conflict(item_id,staff_id,kind,event_at) do nothing;
$$;
revoke all on function app.enqueue_delivery_push(uuid,text,timestamptz,uuid) from public,anon,authenticated;

create function app.capture_delivery_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='item_comments' then
    if exists(select 1 from app.items i join app.staff s on s.id=new.author_id
      where i.id=new.item_id and i.malfunction_reported_at<new.created_at and s.role in ('admin','purchaser')) then
      perform app.enqueue_delivery_push(new.item_id,'reply',new.created_at,new.author_id);
    end if;
  elsif tg_table_name='photo_reviews' then
    if new.approved_at is not null then
      if tg_op='INSERT' then
        perform app.enqueue_delivery_push(new.item_id,'photo',new.approved_at,new.approved_by);
      elsif new.approved_at is distinct from old.approved_at then
        perform app.enqueue_delivery_push(new.item_id,'photo',new.approved_at,new.approved_by);
      end if;
    end if;
  else
    if new.deliverer_id is not null and new.shipped_on is null and new.sold_on is null then
      if tg_op='INSERT' then
        perform app.enqueue_delivery_push(new.id,'assigned',clock_timestamp(),app.current_staff_id());
      elsif new.deliverer_id is distinct from old.deliverer_id then
        perform app.enqueue_delivery_push(new.id,'assigned',clock_timestamp(),app.current_staff_id());
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.capture_delivery_push() from public,anon,authenticated;
create trigger item_comments_delivery_push after insert on app.item_comments for each row execute function app.capture_delivery_push();
create trigger photo_reviews_delivery_push after insert or update of approved_at on app.photo_reviews for each row execute function app.capture_delivery_push();
create trigger items_delivery_push after insert or update of deliverer_id on app.items for each row execute function app.capture_delivery_push();

-- Only the Edge Function's service client may read/store encrypted server keys.
create function app.delivery_push_config() returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(name,decrypted_secret),'{}'::jsonb) from vault.decrypted_secrets
  where name in ('delivery_push_vapid','delivery_push_public_key','delivery_push_dispatch_token','delivery_push_project_url');
$$;
create function app.initialize_delivery_push(p_vapid text,p_public_key text,p_project_url text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(1735907184);
  if exists(select 1 from vault.secrets where name='delivery_push_vapid') then
    perform cron.schedule('delivery-task-web-push','* * * * *','select app.kick_delivery_push();');
    return;
  end if;
  perform vault.create_secret(p_vapid,'delivery_push_vapid');
  perform vault.create_secret(p_public_key,'delivery_push_public_key');
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'delivery_push_dispatch_token');
  perform vault.create_secret(p_project_url,'delivery_push_project_url');
  perform cron.schedule('delivery-task-web-push','* * * * *','select app.kick_delivery_push();');
end;
$$;
revoke all on function app.delivery_push_config(),app.initialize_delivery_push(text,text,text) from public,anon,authenticated;
grant execute on function app.delivery_push_config(),app.initialize_delivery_push(text,text,text) to service_role;

create function app.claim_delivery_push() returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text,base_url text,item_id uuid,lot_seq integer,kind text,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
  update app.delivery_push_deliveries set state='failed'
    where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.delivery_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours'
    on conflict do nothing;
  return query
  with ready as (
    select d.id from app.delivery_push_deliveries d where d.state in ('pending','sending')
      and d.next_attempt_at<=now() and d.attempts<5
    order by d.next_attempt_at limit 20 for update skip locked
  ), claimed as (
    update app.delivery_push_deliveries d set state='sending',attempts=d.attempts+1,next_attempt_at=now()+interval '5 minutes'
      from ready where d.id=ready.id returning d.*
  )
  select d.id,s.id,s.endpoint,s.p256dh,s.auth,s.base_url,i.id,i.lot_seq,e.kind,
    s.enabled and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
    and e.created_at>now()-interval '24 hours'
    and (st.role='admin' or (i.deliverer_id=st.id and st.role='deliverer'))
    and case e.kind
      when 'reply' then i.malfunction_reported_at<e.event_at and coalesce(r.reply_read_at,'-infinity')<e.event_at
      when 'photo' then p.approved_at=e.event_at and coalesce(r.photo_read_at,'-infinity')<e.event_at
      else i.shipped_on is null and i.sold_on is null end
  from claimed d join app.delivery_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id
    join app.staff st on st.id=s.staff_id join app.items i on i.id=e.item_id
    left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=st.id
    left join app.photo_reviews p on p.item_id=i.id;
end;
$$;
create function app.finish_delivery_push(p_id uuid,p_state text,p_status integer) returns void
language sql security definer set search_path='' as $$
  update app.delivery_push_deliveries set
    state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
    sent_at=case when p_state='sent' then now() else sent_at end,
    last_status=p_status,next_attempt_at=now()+interval '1 minute'*greatest(1,attempts)
  where id=p_id and state='sending' and p_state in ('pending','sent','cancelled','failed');
$$;
revoke all on function app.claim_delivery_push(),app.finish_delivery_push(uuid,text,integer) from public,anon,authenticated;
grant execute on function app.claim_delivery_push(),app.finish_delivery_push(uuid,text,integer) to service_role;

create function app.kick_delivery_push() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text; project_url text; request_id bigint;
begin
  if not exists (
    select 1 from app.delivery_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and (d.attempts<5 or d.state='sending')
  ) and not exists (
    select 1 from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' and not exists (
      select 1 from app.delivery_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
  ) then return null; end if;
  select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
  select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
  if dispatch_token is null or project_url is null then return null; end if;
  select net.http_post(url:=project_url||'/functions/v1/delivery-push',
    headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
    body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=10000) into request_id;
  return request_id;
end;
$$;
revoke all on function app.kick_delivery_push() from public,anon,authenticated;
grant execute on function app.kick_delivery_push() to service_role;
-- Scheduling is performed on the production project after initializing Vault.


-- ▼▼▼ 20261007004701_admin_task_web_push.sql ▼▼▼

alter table app.delivery_push_subscriptions add column app_kind text not null default 'delivery'
  check(app_kind in ('admin','delivery'));

create table app.admin_push_events (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references app.staff(id) on delete cascade,
  kind text not null check(kind in ('malfunction','action','photo_review','invoice','receipts')),
  source_id uuid not null,
  item_id uuid references app.items(id) on delete cascade,
  invoice_staff_id uuid references app.staff(id) on delete cascade,
  billing_month date,
  source_version integer,
  event_at timestamptz not null,
  source_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(staff_id,source_key)
);
create index admin_push_events_staff_idx on app.admin_push_events(staff_id,created_at);
create index admin_push_events_item_idx on app.admin_push_events(item_id);
create index admin_push_events_invoice_staff_idx on app.admin_push_events(invoice_staff_id,billing_month,created_at);
create table app.admin_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references app.admin_push_events(id) on delete cascade,
  subscription_id uuid not null references app.delivery_push_subscriptions(id) on delete cascade,
  state text not null default 'pending' check(state in ('pending','sending','sent','cancelled','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_status integer,
  unique(event_id,subscription_id)
);
create index admin_push_deliveries_subscription_idx on app.admin_push_deliveries(subscription_id);
create index admin_push_deliveries_pending_idx on app.admin_push_deliveries(next_attempt_at) where state in ('pending','sending');
alter table app.admin_push_events enable row level security;
alter table app.admin_push_deliveries enable row level security;
revoke all on app.admin_push_events,app.admin_push_deliveries from public,anon,authenticated;
grant all on app.admin_push_events,app.admin_push_deliveries to service_role;

create function app.enqueue_admin_push(p_kind text,p_source uuid,p_item uuid,p_staff uuid,p_month date,p_version integer,p_at timestamptz)
returns void language sql security definer set search_path='' as $$
  insert into app.admin_push_events(staff_id,kind,source_id,item_id,invoice_staff_id,billing_month,source_version,event_at,source_key)
  select s.id,p_kind,p_source,p_item,p_staff,p_month,p_version,p_at,
    concat_ws(':',p_kind,p_source,p_month,p_version,extract(epoch from p_at))
  from app.staff s where s.is_active and (s.role='admin' or (p_kind='malfunction' and s.role='purchaser'
    and exists(select 1 from app.items i where i.id=p_item and i.purchaser_id=s.id)))
  on conflict(staff_id,source_key) do nothing;
$$;
revoke all on function app.enqueue_admin_push(text,uuid,uuid,uuid,date,integer,timestamptz) from public,anon,authenticated;

create function app.capture_admin_push() returns trigger
language plpgsql security definer set search_path='' as $$
declare should_send boolean;
begin
  if tg_table_name='items' then
    should_send:=new.malfunction_reported and new.malfunction_resolved_at is null and new.malfunction_reported_at is not null;
    if tg_op='UPDATE' then should_send:=should_send and
      (not old.malfunction_reported or new.malfunction_reported_at is distinct from old.malfunction_reported_at
        or old.malfunction_resolved_at is not null); end if;
    if should_send then perform app.enqueue_admin_push('malfunction',new.id,new.id,null,null,null,new.malfunction_reported_at); end if;
  elsif tg_table_name='item_comments' then
    should_send:=new.task_kind is not null and new.task_completed_at is null;
    if tg_op='UPDATE' then should_send:=should_send and
      (new.task_kind is distinct from old.task_kind or old.task_completed_at is not null); end if;
    if should_send then perform app.enqueue_admin_push('action',new.id,new.item_id,null,null,null,
      case when tg_op='INSERT' then new.created_at else clock_timestamp() end); end if;
  elsif tg_table_name='photo_reviews' then
    should_send:=new.submitted_at is not null and new.approved_at is null;
    if tg_op='UPDATE' then should_send:=should_send and
      (new.submitted_at is distinct from old.submitted_at or old.approved_at is not null); end if;
    if should_send then perform app.enqueue_admin_push('photo_review',new.item_id,new.item_id,null,null,null,new.submitted_at); end if;
  elsif tg_table_name='delivery_invoices' then
    should_send:=not exists(select 1 from app.delivery_invoice_approvals where invoice_id=new.id);
    if tg_op='UPDATE' then should_send:=should_send and new.version is distinct from old.version; end if;
    if should_send then perform app.enqueue_admin_push('invoice',new.id,null,new.staff_id,new.billing_month,new.version,new.updated_at); end if;
  else
    perform app.enqueue_admin_push('receipts',new.staff_id,null,new.staff_id,new.billing_month,new.version,new.submitted_at);
  end if;
  return new;
end;
$$;
revoke all on function app.capture_admin_push() from public,anon,authenticated;
create trigger items_admin_push after insert or update of malfunction_reported,malfunction_reported_at,malfunction_resolved_at
  on app.items for each row execute function app.capture_admin_push();
create trigger item_comments_admin_push after insert or update of task_kind,task_completed_at
  on app.item_comments for each row execute function app.capture_admin_push();
create trigger photo_reviews_admin_push after insert or update of submitted_at,approved_at
  on app.photo_reviews for each row execute function app.capture_admin_push();
create trigger invoices_admin_push after insert or update of version on app.delivery_invoices for each row execute function app.capture_admin_push();
create trigger receipts_admin_push after insert or update on app.invoice_receipt_submissions for each row execute function app.capture_admin_push();

create function app.claim_admin_push()
returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text,base_url text,item_id uuid,lot_seq integer,kind text,
  task_id uuid,invoice_staff_id uuid,billing_month date,owner_name text,task_name text,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
  update app.admin_push_deliveries set state='failed' where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.admin_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.admin_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='admin' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' on conflict do nothing;
  return query
  with ready as (
    select d.id from app.admin_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and d.attempts<5
    order by d.next_attempt_at limit 20 for update skip locked
  ), claimed as (
    update app.admin_push_deliveries d set state='sending',attempts=d.attempts+1,next_attempt_at=now()+interval '5 minutes'
    from ready where d.id=ready.id returning d.*
  )
  select d.id,s.id,s.endpoint,s.p256dh,s.auth,s.base_url,e.item_id,i.lot_seq,e.kind,
    case when e.kind='action' then e.source_id end,e.invoice_staff_id,e.billing_month,coalesce(owner.display_name,owner.name),c.task_kind,
    coalesce(s.enabled and s.app_kind='admin' and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
      and e.created_at>now()-interval '24 hours'
      and (st.role='admin' or (e.kind='malfunction' and st.role='purchaser' and i.purchaser_id=st.id))
      and case e.kind
        when 'malfunction' then i.malfunction_reported and i.malfunction_resolved_at is null and i.malfunction_reported_at=e.event_at
        when 'action' then c.task_kind is not null and c.task_completed_at is null
        when 'photo_review' then p.approved_at is null and p.submitted_at=e.event_at
        when 'invoice' then inv.version=e.source_version and not exists(select 1 from app.delivery_invoice_approvals a where a.invoice_id=inv.id)
        else rec.version=e.source_version and not exists(select 1 from app.delivery_invoices vi join app.delivery_invoice_approvals a on a.invoice_id=vi.id
          where vi.staff_id=e.invoice_staff_id and vi.billing_month=e.billing_month) end
      and (e.kind not in ('invoice','receipts') or not exists(
        select 1 from app.admin_push_events newer where newer.staff_id=e.staff_id and newer.invoice_staff_id=e.invoice_staff_id
          and newer.billing_month=e.billing_month and newer.kind in ('invoice','receipts') and newer.created_at>e.created_at)),false)
  from claimed d join app.admin_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id join app.staff st on st.id=s.staff_id
    left join app.items i on i.id=e.item_id left join app.item_comments c on c.id=e.source_id and e.kind='action'
    left join app.photo_reviews p on p.item_id=e.item_id
    left join app.delivery_invoices inv on inv.id=e.source_id and e.kind='invoice'
    left join app.invoice_receipt_submissions rec on rec.staff_id=e.invoice_staff_id and rec.billing_month=e.billing_month
    left join app.staff owner on owner.id=e.invoice_staff_id;
end;
$$;
create function app.finish_admin_push(p_id uuid,p_state text,p_status integer) returns void
language sql security definer set search_path='' as $$
  update app.admin_push_deliveries set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
    sent_at=case when p_state='sent' then now() else sent_at end,last_status=p_status,
    next_attempt_at=now()+interval '1 minute'*greatest(1,attempts)
  where id=p_id and state='sending' and p_state in ('pending','sent','cancelled','failed');
$$;
revoke all on function app.claim_admin_push(),app.finish_admin_push(uuid,text,integer) from public,anon,authenticated;
grant execute on function app.claim_admin_push(),app.finish_admin_push(uuid,text,integer) to service_role;

create or replace function app.claim_delivery_push() returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text,base_url text,item_id uuid,lot_seq integer,kind text,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
  update app.delivery_push_deliveries set state='failed'
    where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.delivery_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours'
    on conflict do nothing;
  return query
  with ready as (
    select d.id from app.delivery_push_deliveries d where d.state in ('pending','sending')
      and d.next_attempt_at<=now() and d.attempts<5
    order by d.next_attempt_at limit 20 for update skip locked
  ), claimed as (
    update app.delivery_push_deliveries d set state='sending',attempts=d.attempts+1,next_attempt_at=now()+interval '5 minutes'
      from ready where d.id=ready.id returning d.*
  )
  select d.id,s.id,s.endpoint,s.p256dh,s.auth,s.base_url,i.id,i.lot_seq,e.kind,
    s.enabled and s.app_kind='delivery' and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
    and e.created_at>now()-interval '24 hours'
    and (st.role='admin' or (i.deliverer_id=st.id and st.role='deliverer'))
    and case e.kind
      when 'reply' then i.malfunction_reported_at<e.event_at and coalesce(r.reply_read_at,'-infinity')<e.event_at
      when 'photo' then p.approved_at=e.event_at and coalesce(r.photo_read_at,'-infinity')<e.event_at
      else i.shipped_on is null and i.sold_on is null end
  from claimed d join app.delivery_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id
    join app.staff st on st.id=s.staff_id join app.items i on i.id=e.item_id
    left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=st.id
    left join app.photo_reviews p on p.item_id=i.id;
end;
$$;
create or replace function app.kick_delivery_push() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text; project_url text; request_id bigint;
begin
  if not exists (
    select 1 from app.delivery_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and (d.attempts<5 or d.state='sending')
  ) and not exists (
    select 1 from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' and not exists (
      select 1 from app.delivery_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
    ) and not exists (
    select 1 from app.admin_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and (d.attempts<5 or d.state='sending')
  ) and not exists (
    select 1 from app.admin_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='admin' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' and not exists (
      select 1 from app.admin_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
  ) then return null; end if;
  select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
  select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
  if dispatch_token is null or project_url is null then return null; end if;
  select net.http_post(url:=project_url||'/functions/v1/delivery-push',
    headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
    body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=10000) into request_id;
  return request_id;
end;
$$;


-- ▼▼▼ 20261007005700_admin_invoice_push_updates.sql ▼▼▼

-- Invoice versions are assigned by a BEFORE trigger even when UPDATE targets note/extras.
drop trigger invoices_admin_push on app.delivery_invoices;
create trigger invoices_admin_push after insert or update on app.delivery_invoices
  for each row execute function app.capture_admin_push();


-- ▼▼▼ 20261007010454_automatic_purchase_list.sql ▼▼▼

CREATE OR REPLACE FUNCTION app.extension_sync_purchase_drafts(p_marketplace text, p_account_label text, p_purchases jsonb, p_stop_on_match boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  row_data jsonb;
  inserted_count integer := 0;
  refreshed_count integer := 0;
  matched_item_ids text[] := array[]::text[];
  v_id text;
  v_title text;
  v_url text;
  v_price bigint;
  v_date date;
  v_model_no text;
  v_product_id uuid;
  v_product_no integer;
  v_asin char(10);
  v_planned_price bigint;
  v_planned_payout bigint;
  v_best_model_length integer;
  v_best_model_count integer;
  was_inserted boolean;
  v_existing_item uuid;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_account_label),'') is null or length(p_account_label)>120 then raise exception 'アカウント名が不正です'; end if;
  if jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then raise exception '購入履歴の形式または件数が不正です'; end if;
  for row_data in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(row_data->>'marketplace_item_id'),'');
    v_title := nullif(btrim(row_data->>'title'),'');
    v_url := nullif(btrim(row_data->>'marketplace_url'),'');
    if v_id is null or v_title is null or v_url is null or length(v_id)>200 or length(v_title)>500 or length(v_url)>2000 then continue; end if;
    if (p_marketplace='メルカリ' and v_url !~ '^https://jp\.mercari\.com/')
      or (p_marketplace='ヤフオク' and v_url !~ '^https://(auctions|page\.auctions|contact\.auctions|buy\.auctions)\.yahoo\.co\.jp/')
      or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_url !~ '^https://paypayfleamarket(-sec)?\.yahoo\.co\.jp/')
      or (p_marketplace='ラクマ' and v_url !~ '^https://(www\.)?fril\.jp/' and v_url !~ '^https://item\.fril\.jp/') then continue; end if;

    v_product_id := null; v_model_no := null; v_product_no := null; v_asin := null;
    v_planned_price := null; v_planned_payout := null; v_best_model_length := null; v_best_model_count := 0;
    select max(length(btrim(p.model_no))) into v_best_model_length
      from app.products p
      where p.is_active and nullif(btrim(p.model_no),'') is not null
        and position(lower(btrim(p.model_no)) in lower(v_title))>0;
    if v_best_model_length is not null then
      select count(*) into v_best_model_count from app.products p
        where p.is_active and nullif(btrim(p.model_no),'') is not null
          and length(btrim(p.model_no))=v_best_model_length
          and position(lower(btrim(p.model_no)) in lower(v_title))>0;
      if v_best_model_count=1 then
        select p.id,p.model_no,p.product_no,p.asin,p.list_price,p.payout_estimate
          into v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout
          from app.products p
          where p.is_active and nullif(btrim(p.model_no),'') is not null
            and length(btrim(p.model_no))=v_best_model_length
            and position(lower(btrim(p.model_no)) in lower(v_title))>0
          limit 1;
      end if;
    end if;

    select i.id into v_existing_item from app.items i
      where i.marketplace_item_id=v_id
        and (i.marketplace::text=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
      order by i.created_at desc limit 1;
    if v_existing_item is not null then
      insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,state,registered_item_id,product_id,model_no,product_no,asin,planned_price,planned_payout)
        values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,
          case when coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then (row_data->>'purchased_at')::date else null end,
          case when coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then (row_data->>'cost_amount')::bigint else null end,
          'registered',v_existing_item,v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout)
        on conflict(marketplace,marketplace_item_id) do nothing;
      matched_item_ids := array_append(matched_item_ids,v_id);
      if p_stop_on_match then exit; end if;
      continue;
    end if;

    v_price := null;
    if coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then v_price := (row_data->>'cost_amount')::bigint; end if;
    v_date := null;
    if coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then v_date := (row_data->>'purchased_at')::date; end if;
    insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,product_id,model_no,product_no,asin,planned_price,planned_payout)
      values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,v_date,v_price,v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout)
      on conflict(marketplace,marketplace_item_id) do update set
        marketplace_url=excluded.marketplace_url,
        account_label=excluded.account_label,
        title=excluded.title,
        purchased_at=coalesce(excluded.purchased_at,app.marketplace_purchase_drafts.purchased_at),
        cost_amount=coalesce(excluded.cost_amount,app.marketplace_purchase_drafts.cost_amount),
        product_id=coalesce(excluded.product_id,app.marketplace_purchase_drafts.product_id),
        model_no=coalesce(excluded.model_no,app.marketplace_purchase_drafts.model_no),
        product_no=coalesce(excluded.product_no,app.marketplace_purchase_drafts.product_no),
        asin=coalesce(excluded.asin,app.marketplace_purchase_drafts.asin),
        planned_price=coalesce(excluded.planned_price,app.marketplace_purchase_drafts.planned_price),
        planned_payout=coalesce(excluded.planned_payout,app.marketplace_purchase_drafts.planned_payout),
        last_seen_at=now()
      where app.marketplace_purchase_drafts.state='draft'
      returning (xmax=0) into was_inserted;
    if found then
      if was_inserted then inserted_count := inserted_count+1;
      else refreshed_count := refreshed_count+1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'refreshed',refreshed_count,'matched_item_ids',to_jsonb(matched_item_ids));
end $function$

;
create or replace function app.marketplace_purchase_context(p_marketplace text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date; v_ids jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  select coalesce(jsonb_agg(distinct id),'[]'::jsonb) into v_ids from (
    select marketplace_item_id as id from app.items where marketplace_item_id is not null
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))
    union select marketplace_item_id from app.marketplace_purchase_drafts
      where marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')
  ) known;
  return jsonb_build_object('day',v_day,'cutoff',(v_day-interval '1 month')::date,'knownIds',v_ids);
end $$;
revoke all on function app.marketplace_purchase_context(text) from public,anon;
grant execute on function app.marketplace_purchase_context(text) to authenticated;

create or replace function app.marketplace_purchase_import(p_marketplace text,p_account_label text,p_purchases jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_cutoff date := (v_day-interval '1 month')::date; r jsonb; v_id text; v_date date;
  v_inserted int := 0; v_skipped int := 0; v_rejected int := 0; v_result jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if p_purchases is null or jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then
    raise exception '購入履歴の形式または件数が不正です'; end if;
  for r in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(r->>'marketplace_item_id'),''); v_date := null;
    begin
      if coalesce(r->>'purchased_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then v_date := (r->>'purchased_at')::date; end if;
    exception when datetime_field_overflow or invalid_datetime_format then v_date := null; end;
    if coalesce((r->>'cancelled')::boolean,false) or v_id is null or v_date is null or v_date<v_cutoff or v_date>v_day then v_rejected:=v_rejected+1; continue; end if;
    if r->>'marketplace_url' <> (case v_site when 'メルカリ' then 'https://jp.mercari.com/item/' when 'ヤフオク' then 'https://auctions.yahoo.co.jp/jp/auction/' when 'ヤフフリ' then 'https://paypayfleamarket.yahoo.co.jp/item/' when 'ラクマ' then 'https://item.fril.jp/' end || v_id) then v_rejected:=v_rejected+1; continue; end if;
    if exists(select 1 from app.items where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')))
      or exists(select 1 from app.marketplace_purchase_drafts where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))) then
      v_skipped:=v_skipped+1; continue; end if;
    v_result := app.extension_sync_purchase_drafts(v_site,p_account_label,jsonb_build_array(r),false);
    if coalesce((v_result->>'inserted')::int,0)>0 then v_inserted:=v_inserted+1;
    elsif jsonb_array_length(coalesce(v_result->'matched_item_ids','[]'::jsonb))>0 then v_skipped:=v_skipped+1;
    else v_rejected:=v_rejected+1; end if;
  end loop;
  return jsonb_build_object('inserted',v_inserted,'skipped',v_skipped,'rejected',v_rejected);
end $$;
revoke all on function app.marketplace_purchase_import(text,text,jsonb) from public,anon;
grant execute on function app.marketplace_purchase_import(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261007011859_purchase_draft_missing_price_refresh.sql ▼▼▼

create or replace function app.marketplace_purchase_context(p_marketplace text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date; v_ids jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  select coalesce(jsonb_agg(distinct id),'[]'::jsonb) into v_ids from (
    select marketplace_item_id as id from app.items where marketplace_item_id is not null
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))
    union select marketplace_item_id from app.marketplace_purchase_drafts
      where (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')) and (state<>'draft' or cost_amount is not null)
  ) known;
  return jsonb_build_object('day',v_day,'cutoff',(v_day-interval '1 month')::date,'knownIds',v_ids);
end $$;
revoke all on function app.marketplace_purchase_context(text) from public,anon;
grant execute on function app.marketplace_purchase_context(text) to authenticated;

create or replace function app.marketplace_purchase_import(p_marketplace text,p_account_label text,p_purchases jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_cutoff date := (v_day-interval '1 month')::date; r jsonb; v_id text; v_date date;
  v_inserted int := 0; v_refreshed int := 0; v_skipped int := 0; v_rejected int := 0; v_result jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if p_purchases is null or jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then
    raise exception '購入履歴の形式または件数が不正です'; end if;
  for r in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(r->>'marketplace_item_id'),''); v_date := null;
    begin
      if coalesce(r->>'purchased_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then v_date := (r->>'purchased_at')::date; end if;
    exception when datetime_field_overflow or invalid_datetime_format then v_date := null; end;
    if coalesce((r->>'cancelled')::boolean,false) or v_id is null or v_date is null or v_date<v_cutoff or v_date>v_day then v_rejected:=v_rejected+1; continue; end if;
    if r->>'marketplace_url' <> (case v_site when 'メルカリ' then 'https://jp.mercari.com/item/' when 'ヤフオク' then 'https://auctions.yahoo.co.jp/jp/auction/' when 'ヤフフリ' then 'https://paypayfleamarket.yahoo.co.jp/item/' when 'ラクマ' then 'https://item.fril.jp/' end || v_id) then v_rejected:=v_rejected+1; continue; end if;
    if exists(select 1 from app.items where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')))
      or exists(select 1 from app.marketplace_purchase_drafts where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')) and (state<>'draft' or cost_amount is not null)) then
      v_skipped:=v_skipped+1; continue; end if;
    v_result := app.extension_sync_purchase_drafts(v_site,p_account_label,jsonb_build_array(r),false);
    if coalesce((v_result->>'inserted')::int,0)>0 then v_inserted:=v_inserted+1;
    elsif coalesce((v_result->>'refreshed')::int,0)>0 then v_refreshed:=v_refreshed+1; v_skipped:=v_skipped+1;
    elsif jsonb_array_length(coalesce(v_result->'matched_item_ids','[]'::jsonb))>0 then v_skipped:=v_skipped+1;
    else v_rejected:=v_rejected+1; end if;
  end loop;
  return jsonb_build_object('inserted',v_inserted,'refreshed',v_refreshed,'skipped',v_skipped,'rejected',v_rejected);
end $$;
revoke all on function app.marketplace_purchase_import(text,text,jsonb) from public,anon;
grant execute on function app.marketplace_purchase_import(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261007013525_purchase_site_scan_lease.sql ▼▼▼

create table if not exists app.marketplace_purchase_leases (
  marketplace text primary key check (marketplace in ('メルカリ','ヤフオク','ヤフフリ','ラクマ')),
  owner_id uuid not null, expires_at timestamptz not null
);
alter table app.marketplace_purchase_leases enable row level security;
revoke all on app.marketplace_purchase_leases from anon;
grant select,insert,update,delete on app.marketplace_purchase_leases to authenticated;
create policy marketplace_purchase_leases_admin on app.marketplace_purchase_leases to authenticated using (app.is_admin()) with check (app.is_admin());
create or replace function app.marketplace_purchase_lease(p_marketplace text,p_owner uuid,p_action text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_site text:=case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end; held uuid;
begin
 if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
 if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') or p_owner is null then raise exception '取得対象が不正です'; end if;
 if p_action='release' then delete from app.marketplace_purchase_leases where marketplace=v_site and owner_id=p_owner;return true;end if;
 if p_action<>'acquire' then raise exception '取得操作が不正です';end if;
 insert into app.marketplace_purchase_leases(marketplace,owner_id,expires_at) values(v_site,p_owner,now()+interval '2 minutes')
 on conflict(marketplace) do update set owner_id=excluded.owner_id,expires_at=excluded.expires_at
 where app.marketplace_purchase_leases.owner_id=p_owner or app.marketplace_purchase_leases.expires_at<now()
 returning owner_id into held;
 return held=p_owner;
end $$;
revoke all on function app.marketplace_purchase_lease(text,uuid,text) from public,anon;
grant execute on function app.marketplace_purchase_lease(text,uuid,text) to authenticated;
notify pgrst,'reload schema';

-- ▼▼▼ 20261007013527_sync_inventory_delivery_models.sql ▼▼▼

-- Both apps read the same live catalog model. Existing product links take priority;
-- ASIN is an exact, unique fallback only for rows without a product link.
-- Never use the historical FNSKU stored in items.title as a model number.
create or replace view app.v_items with (security_invoker = on) as
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
left join app.products p on p.id = i.product_id
  or (i.product_id is null and p.asin = i.asin)
left join app.payment_cards c on c.id = i.card_id
left join app.staff buyer    on buyer.id = i.purchaser_id
left join app.staff deliv    on deliv.id = i.deliverer_id;

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  case when i.is_accessory then shared.sales_channel else i.sales_channel end as sales_channel,
  i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  p.model_no as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id = i.product_id
  or (i.product_id is null and p.asin = i.asin)
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','返品処理','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;


-- ▼▼▼ 20261007014608_preserve_manual_model_titles.sql ▼▼▼

-- Both apps read the same live catalog model. Existing product links take priority;
-- ASIN is an exact, unique fallback for working Amazon returns without a product link.
-- Never use the historical FNSKU stored in items.title as a model number.
create or replace view app.v_items with (security_invoker = on) as
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
left join app.products p on p.id = i.product_id
  or (i.product_id is null and i.marketplace::text = '動作品Amazon返品' and p.asin = i.asin)
left join app.payment_cards c on c.id = i.card_id
left join app.staff buyer    on buyer.id = i.purchaser_id
left join app.staff deliv    on deliv.id = i.deliverer_id;

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  case when i.is_accessory then shared.sales_channel else i.sales_channel end as sales_channel,
  i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  p.model_no as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id = i.product_id
  or (i.product_id is null and i.marketplace::text = '動作品Amazon返品' and p.asin = i.asin)
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','返品処理','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;


-- ▼▼▼ 20261007021522_purchase_two_weeks_once_only.sql ▼▼▼

create or replace function app.marketplace_purchase_context(p_marketplace text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date; v_ids jsonb; v_inventory_ids jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  select coalesce(jsonb_agg(distinct id),'[]'::jsonb) into v_ids from (
    select marketplace_item_id as id from app.items where marketplace_item_id is not null
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))
    union select marketplace_item_id from app.marketplace_purchase_drafts
      where (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))
  ) known;
  select coalesce(jsonb_agg(distinct marketplace_item_id),'[]'::jsonb) into v_inventory_ids from app.items where marketplace_item_id is not null and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'));
  return jsonb_build_object('inventoryIds',v_inventory_ids,'day',v_day,'cutoff',(v_day-14),'knownIds',v_ids);
end $$;
revoke all on function app.marketplace_purchase_context(text) from public,anon;
grant execute on function app.marketplace_purchase_context(text) to authenticated;

create or replace function app.marketplace_purchase_import(p_marketplace text,p_account_label text,p_purchases jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_cutoff date := (v_day-14); r jsonb; v_id text; v_date date;
  v_inserted int := 0; v_refreshed int := 0; v_skipped int := 0; v_rejected int := 0; v_result jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if p_purchases is null or jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then
    raise exception '購入履歴の形式または件数が不正です'; end if;
  for r in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(r->>'marketplace_item_id'),''); v_date := null;
    begin
      if coalesce(r->>'purchased_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then v_date := (r->>'purchased_at')::date; end if;
    exception when datetime_field_overflow or invalid_datetime_format then v_date := null; end;
    if coalesce((r->>'cancelled')::boolean,false) or v_id is null or v_date is null or v_date<v_cutoff or v_date>v_day then v_rejected:=v_rejected+1; continue; end if;
    if r->>'marketplace_url' <> (case v_site when 'メルカリ' then 'https://jp.mercari.com/item/' when 'ヤフオク' then 'https://auctions.yahoo.co.jp/jp/auction/' when 'ヤフフリ' then 'https://paypayfleamarket.yahoo.co.jp/item/' when 'ラクマ' then 'https://item.fril.jp/' end || v_id) then v_rejected:=v_rejected+1; continue; end if;
    if exists(select 1 from app.items where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')))
      or exists(select 1 from app.marketplace_purchase_drafts where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))) then
      v_skipped:=v_skipped+1; continue; end if;
    v_result := app.extension_sync_purchase_drafts(v_site,p_account_label,jsonb_build_array(r),false);
    if coalesce((v_result->>'inserted')::int,0)>0 then v_inserted:=v_inserted+1;
    elsif coalesce((v_result->>'refreshed')::int,0)>0 then v_refreshed:=v_refreshed+1; v_skipped:=v_skipped+1;
    elsif jsonb_array_length(coalesce(v_result->'matched_item_ids','[]'::jsonb))>0 then v_skipped:=v_skipped+1;
    else v_rejected:=v_rejected+1; end if;
  end loop;
  return jsonb_build_object('inserted',v_inserted,'refreshed',v_refreshed,'skipped',v_skipped,'rejected',v_rejected);
end $$;
revoke all on function app.marketplace_purchase_import(text,text,jsonb) from public,anon;
grant execute on function app.marketplace_purchase_import(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261007110119_register_item_with_spare.sql ▼▼▼

-- Register the input item and its reserve accessory in one transaction.
create function app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  -- Serialize this operation without expanding spare-table write privileges.
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text, 179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) and not exists(select 1 from app.items where lot_seq=v_input.lot_seq and not is_accessory) then
    raise exception 'この通番号の本体が見つかりません。本体を先に登録してください' using errcode='22023';
  end if;
  insert into app.items (sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id)
  values (v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'作業中'::app.item_status),v_input.memo,v_input.source_purchase_draft_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,sales_channel,memo)
    values (v_item.lot_seq,true,coalesce(v_spare.owner_staff_id,v_item.purchaser_id),v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
        then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end,
      v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.sales_channel,
      v_spare.usage_note)
    returning * into v_accessory;
  end if;
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$$;
revoke all on function app.register_item_with_spare(jsonb,uuid) from public,anon;
grant execute on function app.register_item_with_spare(jsonb,uuid) to authenticated;


-- ▼▼▼ 20261007124829_preserve_manual_sale_after_return.sql ▼▼▼

create or replace function app.items_mark_sold()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Preserve a deliberate sale override without deleting the historic return date.
  -- A newly entered/changed return date still starts return processing.
  if tg_op = 'UPDATE' and new.status = '販売済'
     and old.status in ('返品処理', '販売済')
     and new.returned_on is not null
     and new.returned_on is not distinct from old.returned_on then
    return new;
  end if;
  if new.sold_on is not null
     and not new.is_accessory
     and new.status <> '返品処理'
     and new.amazon_returned_on is null then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then
    new.status := '返品処理';
  end if;
  return new;
end;
$$;


-- ▼▼▼ 20261007130557_expire_delivery_notices_after_three_days.sql ▼▼▼

-- Hide each unread notice 72 hours after its source event, without deleting history.
-- Keep the existing caller/assignee checks and the exact-event acknowledgement API.
create or replace function app.list_delivery_item_notices()
returns table(item_id uuid, lot_seq bigint, reply_at timestamptz, photo_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with notices as (
    select i.id, i.lot_seq::bigint,
      case when c.last_reply > coalesce(r.reply_read_at, '-infinity'::timestamptz)
        and c.last_reply > now() - interval '72 hours' then c.last_reply end as reply_at,
      case when p.approved_at > coalesce(r.photo_read_at, '-infinity'::timestamptz)
        and p.approved_at > now() - interval '72 hours' then p.approved_at end as photo_at
    from app.items i
    left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=app.current_staff_id()
    left join app.photo_reviews p on p.item_id=i.id
    left join lateral (
      select max(cm.created_at) last_reply from app.item_comments cm
      join app.staff s on s.id=cm.author_id
      where cm.item_id=i.id and cm.created_at>i.malfunction_reported_at
        and cm.author_id<>app.current_staff_id() and s.role in ('admin','purchaser')
    ) c on true
    where auth.uid() is not null and app.current_staff_id() is not null and app.current_role() is not null
      and (app.is_admin() or i.deliverer_id=app.current_staff_id())
  )
  select id, lot_seq, reply_at, photo_at from notices
  where reply_at is not null or photo_at is not null;
$$;
revoke all on function app.list_delivery_item_notices() from public, anon;
grant execute on function app.list_delivery_item_notices() to authenticated;


-- ▼▼▼ 20261007140905_spare_shipping_tasks.sql ▼▼▼

-- Explicit source/target links preserve the accessory identity throughout shipping.
create table app.spare_shipping_tasks (
  id uuid primary key default gen_random_uuid(),
  spare_id uuid not null unique references app.spare_accessories(id),
  item_id uuid not null references app.items(id) on delete cascade,
  accessory_item_id uuid not null unique references app.items(id) on delete cascade,
  owner_staff_id uuid not null references app.staff(id),
  recipient_staff_id uuid not null references app.staff(id),
  title text not null, manufacturer text, marketplace text, marketplace_item_id text, usage_note text,
  lot_seq integer not null,
  tracking_no text,
  created_at timestamptz not null default now(),
  sent_at timestamptz, completed_at timestamptz,
  check(owner_staff_id<>recipient_staff_id),
  check((sent_at is null and tracking_no is null) or (sent_at is not null and nullif(btrim(tracking_no),'') is not null)),
  check(completed_at is null or sent_at is not null)
);
create index spare_shipping_owner_pending_idx on app.spare_shipping_tasks(owner_staff_id,created_at)
  where sent_at is null and completed_at is null;
alter table app.spare_shipping_tasks enable row level security;
revoke all on app.spare_shipping_tasks from public,anon,authenticated;
grant select on app.spare_shipping_tasks to authenticated;
grant all on app.spare_shipping_tasks to service_role;
create policy spare_shipping_read on app.spare_shipping_tasks for select to authenticated
using (app.current_role() is not null and (app.is_admin() or owner_staff_id=app.current_staff_id()));

create view app.v_spare_shipping_tasks with (security_invoker=true) as
select t.*,o.code owner_code,o.name owner_name,d.code recipient_code,d.name recipient_name
from app.spare_shipping_tasks t join app.staff o on o.id=t.owner_staff_id
join app.staff d on d.id=t.recipient_staff_id;
revoke all on app.v_spare_shipping_tasks from public,anon,authenticated;
grant select on app.v_spare_shipping_tasks to authenticated;

-- Definer is needed only to enqueue for another holder; validate the existing allocation first.
create function app.queue_spare_shipping(p_spare_id uuid,p_item_id uuid,p_accessory_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s app.spare_accessories; i app.items; a app.items; task_id uuid;
begin
  if auth.uid() is null or app.current_role() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '発送依頼を作成する権限がありません' using errcode='42501';
  end if;
  select * into s from app.spare_accessories where id=p_spare_id for update;
  select * into i from app.items where id=p_item_id;
  select * into a from app.items where id=p_accessory_id;
  if s.id is null or i.id is null or a.id is null or s.used_for_item_id is distinct from i.id
    or not a.is_accessory or a.lot_seq is distinct from i.lot_seq
    or a.deliverer_id is distinct from i.deliverer_id
    or a.title is distinct from s.title or a.marketplace_item_id is distinct from s.marketplace_item_id
    or a.purchaser_id is distinct from coalesce(s.owner_staff_id,i.purchaser_id)
    or (not app.is_admin() and (s.owner_staff_id is distinct from app.current_staff_id()
      or i.purchaser_id is distinct from app.current_staff_id())) then
    raise exception '予備と付属品の紐づけを確認できません' using errcode='22023';
  end if;
  if s.owner_staff_id is null or i.deliverer_id is null or s.owner_staff_id=i.deliverer_id then return null; end if;
  if not exists(select 1 from app.staff where id=s.owner_staff_id and is_active)
    or not exists(select 1 from app.staff where id=i.deliverer_id and is_active) then
    raise exception '発送元または発送先の担当者が無効です' using errcode='22023';
  end if;
  insert into app.spare_shipping_tasks(spare_id,item_id,accessory_item_id,owner_staff_id,recipient_staff_id,
    title,manufacturer,marketplace,marketplace_item_id,usage_note,lot_seq)
  values(s.id,i.id,a.id,s.owner_staff_id,i.deliverer_id,s.title,s.manufacturer,s.marketplace,
    s.marketplace_item_id,s.usage_note,i.lot_seq)
  on conflict(spare_id) do nothing returning id into task_id;
  if task_id is null then
    select id into task_id from app.spare_shipping_tasks where spare_id=s.id
      and item_id=i.id and accessory_item_id=a.id;
    if task_id is null then raise exception '既存の発送依頼と紐づけが異なります' using errcode='22023'; end if;
  end if;
  return task_id;
end $$;
revoke all on function app.queue_spare_shipping(uuid,uuid,uuid) from public,anon;
grant execute on function app.queue_spare_shipping(uuid,uuid,uuid) to authenticated;

-- The holder may update only the exact linked accessory's tracking number.
create function app.send_spare_shipping(p_task_id uuid,p_tracking_no text)
returns void language plpgsql security definer set search_path='' as $$
declare t app.spare_shipping_tasks; tracking text:=nullif(btrim(p_tracking_no),'');
begin
  if auth.uid() is null or app.current_role() is null then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  select * into t from app.spare_shipping_tasks where id=p_task_id for update;
  if t.id is null or t.owner_staff_id is distinct from app.current_staff_id() then
    raise exception '自分の発送依頼のみ送信できます' using errcode='42501';
  end if;
  if tracking is null or length(tracking)>200 then
    raise exception '追跡番号を1〜200文字で入力してください' using errcode='22023';
  end if;
  if t.sent_at is not null then
    if t.tracking_no=tracking then return; end if;
    raise exception 'この発送依頼は送信済みです' using errcode='22023';
  end if;
  if not exists(select 1 from app.items where id=t.item_id and deliverer_id=t.recipient_staff_id)
    or not exists(select 1 from app.spare_accessories where id=t.spare_id and used_for_item_id=t.item_id
      and owner_staff_id=t.owner_staff_id) then
    raise exception '担当者または予備の割当が変更されています。管理者に確認してください' using errcode='22023';
  end if;
  update app.items set tracking_no=tracking where id=t.accessory_item_id
    and is_accessory and lot_seq=t.lot_seq and deliverer_id=t.recipient_staff_id;
  if not found then raise exception '発送先の付属品が変更されています' using errcode='22023'; end if;
  update app.spare_shipping_tasks set tracking_no=tracking,sent_at=now() where id=t.id;
end $$;
revoke all on function app.send_spare_shipping(uuid,text) from public,anon;
grant execute on function app.send_spare_shipping(uuid,text) to authenticated;

create function app.complete_spare_shipping(p_task_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者のみ完了できます' using errcode='42501';
  end if;
  update app.spare_shipping_tasks set completed_at=coalesce(completed_at,now())
    where id=p_task_id and sent_at is not null;
  if not found then raise exception '発送済みのタスクが見つかりません' using errcode='22023'; end if;
end $$;
grant update(completed_at) on app.spare_shipping_tasks to authenticated;
create policy spare_shipping_complete on app.spare_shipping_tasks for update to authenticated
using(app.is_admin() and sent_at is not null) with check(app.is_admin() and sent_at is not null);
revoke all on function app.complete_spare_shipping(uuid) from public,anon;
grant execute on function app.complete_spare_shipping(uuid) to authenticated;

-- Register the input item and its reserve accessory in one transaction.
create or replace function app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  -- Serialize this operation without expanding spare-table write privileges.
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text, 179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) and not exists(select 1 from app.items where lot_seq=v_input.lot_seq and not is_accessory) then
    raise exception 'この通番号の本体が見つかりません。本体を先に登録してください' using errcode='22023';
  end if;
  insert into app.items (sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id)
  values (v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'作業中'::app.item_status),v_input.memo,v_input.source_purchase_draft_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,sales_channel,memo)
    values (v_item.lot_seq,true,coalesce(v_spare.owner_staff_id,v_item.purchaser_id),v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
        then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end,
      v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.sales_channel,
      v_spare.usage_note)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$$;
revoke all on function app.register_item_with_spare(jsonb,uuid) from public,anon;
grant execute on function app.register_item_with_spare(jsonb,uuid) to authenticated;


-- ▼▼▼ 20261007142707_preserve_sku_on_purchase_date_alias_conflict.sql ▼▼▼

-- A date-only correction must not take over another product's historical SKU.
-- Retain the existing SKU in that narrow case; all other identity collision checks remain.
create or replace function app.sync_sku_from_item_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare purchaser_code text; deliverer_code text; middle_code text; date_part text; suffix text;
  purchase_date_only boolean := new.purchased_at is distinct from old.purchased_at
    and new.lot_seq is not distinct from old.lot_seq
    and new.purchaser_id is not distinct from old.purchaser_id
    and new.deliverer_id is not distinct from old.deliverer_id
    and new.cost_amount is not distinct from old.cost_amount
    and new.sku is not distinct from old.sku;
begin
  if new.lot_seq is distinct from old.lot_seq
      or new.purchaser_id is distinct from old.purchaser_id
      or new.deliverer_id is distinct from old.deliverer_id
      or new.purchased_at is distinct from old.purchased_at
      or new.cost_amount is distinct from old.cost_amount then
    select code into purchaser_code from app.staff where id=new.purchaser_id;
    select code into deliverer_code from app.staff where id=new.deliverer_id;
    middle_code := coalesce(purchaser_code,'') || coalesce(deliverer_code,'');
    if middle_code='' then middle_code:=split_part(old.sku,'-',2); end if;
    if length(middle_code) not in (2,4) then raise exception '担当者コードを確認してください' using errcode='22023'; end if;
    date_part := case when new.purchased_at is null then split_part(old.sku,'-',3)
                      else to_char(new.purchased_at,'YYYYMMDD') end;
    suffix := coalesce(substring(new.sku from '^[0-9]+([a-z]+)-'),
                       substring(old.sku from '^[0-9]+([a-z]+)-'), '');
    new.sku := new.lot_seq::text || suffix || '-' || middle_code || '-' || date_part || '-' || (new.cost_amount / 10)::bigint;
  end if;
  if exists (select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then
    if purchase_date_only and not exists(
      select 1 from app.item_sku_aliases a where a.sku=old.sku and a.item_id<>new.id
    ) then
      new.sku:=old.sku;
    else
      raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';
    end if;
  end if;
  return new;
end $$;


-- ▼▼▼ 20261007165309_allow_aa_spare_shipping.sql ▼▼▼

-- AA administrator may ship on behalf of the holder; all fixed-link and retry checks remain.
create or replace function app.send_spare_shipping(p_task_id uuid,p_tracking_no text)
returns void language plpgsql security definer set search_path='' as $$
declare t app.spare_shipping_tasks; tracking text:=nullif(btrim(p_tracking_no),'');
begin
  if auth.uid() is null or app.current_role() is null then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  select * into t from app.spare_shipping_tasks where id=p_task_id for update;
  if t.id is null or (t.owner_staff_id is distinct from app.current_staff_id()
    and not (coalesce(app.is_admin(), false) and exists(
      select 1 from app.staff where id=app.current_staff_id() and code='AA' and is_active
    ))) then
    raise exception 'この発送依頼を送信する権限がありません' using errcode='42501';
  end if;
  if tracking is null or length(tracking)>200 then
    raise exception '追跡番号を1〜200文字で入力してください' using errcode='22023';
  end if;
  if t.sent_at is not null then
    if t.tracking_no=tracking then return; end if;
    raise exception 'この発送依頼は送信済みです' using errcode='22023';
  end if;
  if not exists(select 1 from app.items where id=t.item_id and deliverer_id=t.recipient_staff_id)
    or not exists(select 1 from app.spare_accessories where id=t.spare_id and used_for_item_id=t.item_id
      and owner_staff_id=t.owner_staff_id) then
    raise exception '担当者または予備の割当が変更されています。管理者に確認してください' using errcode='22023';
  end if;
  update app.items set tracking_no=tracking where id=t.accessory_item_id
    and is_accessory and lot_seq=t.lot_seq and deliverer_id=t.recipient_staff_id;
  if not found then raise exception '発送先の付属品が変更されています' using errcode='22023'; end if;
  update app.spare_shipping_tasks set tracking_no=tracking,sent_at=now() where id=t.id;
end $$;
revoke all on function app.send_spare_shipping(uuid,text) from public,anon;
grant execute on function app.send_spare_shipping(uuid,text) to authenticated;



-- ▼▼▼ 20261007174745_preserve_allocated_return_spare_accessory.sql ▼▼▼

create or replace function app.enforce_amazon_return_main_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  numeric_serial text;
  separator_and_tail text;
  requested_depth integer;
  existing_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then
    return new;
  end if;

  -- A reserve recovered from an Amazon return remains an accessory when
  -- registered together with its explicitly allocated main item. All source
  -- identity fields must match; ordinary return registrations stay main items.
  if tg_op = 'INSERT' and new.is_accessory and new.work_stream::text = '付属品'
    and auth.uid() is not null and app.current_role() in ('admin','purchaser')
    and exists (
      select 1 from app.spare_accessories s join app.items i on i.id=s.used_for_item_id
      where not i.is_accessory and i.lot_seq=new.lot_seq
        and i.created_by=app.current_staff_id()
        and i.deliverer_id is not distinct from new.deliverer_id
        and s.title is not distinct from new.title
        and s.marketplace_item_id is not distinct from new.marketplace_item_id
        and s.asin is not distinct from new.asin
        and s.cost_amount is not distinct from new.cost_amount
        and s.purchased_at is not distinct from new.purchased_at
        and new.purchaser_id is not distinct from coalesce(s.owner_staff_id,i.purchaser_id)
        and (app.is_admin() or s.owner_staff_id=app.current_staff_id())
    ) then return new; end if;

  if tg_op <> 'INSERT' then
    if new.status::text = 'Amazon返品' or new.amazon_returned_on is not null then
      new.is_accessory := false;
    end if;
    return new;
  end if;

  new.is_accessory := false;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if numeric_serial is null or separator_and_tail is null then
    return new;
  end if;

  -- Serialize return registrations for a product so concurrent submissions
  -- cannot receive the same suffix.
  perform pg_advisory_xact_lock(hashtextextended('amazon-return:' || new.lot_seq::text || ':' || numeric_serial, 179049));

  select coalesce(max(length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''))), 0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and (regexp_match(i.sku, '^([0-9]+)'))[1] = numeric_serial;

  requested_depth := length(coalesce((regexp_match(new.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  return new;
end;
$$;


-- ▼▼▼ 20261007212714_remove_retired_purchase_statuses.sql ▼▼▼

-- Remove retired states from all live filtering/summary views. Preserve
-- column order, existing view options and grants; historical migrations remain.
do $$
declare view_name text; definition text;
begin
  if exists(select 1 from app.items where status::text in ('仕入済','入荷済')) then
    raise exception 'Unexpected retired statuses; reconcile fixed item IDs before applying';
  end if;
  foreach view_name in array array['v_delivery_tasks','v_deliverer_workload','v_stock_summary'] loop
    definition:=pg_get_viewdef(('app.'||view_name)::regclass,true);
    definition:=replace(definition,'''仕入済''::app.item_status, ''入荷済''::app.item_status, ', '');
    -- Compatibility column is unused by either app. Never count retired states.
    definition:=replace(definition,'status = ''仕入済''::app.item_status','false');
    execute 'create or replace view app.'||quote_ident(view_name)||' as '||definition;
  end loop;
end $$;
alter table app.items add constraint items_no_retired_purchase_status
  check(status::text not in ('仕入済','入荷済'));


-- ▼▼▼ 20261007213625_workload_unshipped_amazon_returns.sql ▼▼▼

-- Keep working Amazon returns in workload; exclude shipped returns.
-- Preserve all other metrics, view options, columns and grants.
do $$
declare definition text; old_condition text; new_condition text;
begin
  definition := pg_get_viewdef('app.v_deliverer_workload'::regclass, true);
  old_condition := 'i.status = ANY (ARRAY[''作業中''::app.item_status, ''Amazon返品''::app.item_status])';
  new_condition := '(i.status = ''作業中''::app.item_status OR (i.status = ''Amazon返品''::app.item_status AND i.shipped_on IS NULL))';
  if position(old_condition in definition) = 0 then
    raise exception 'Expected workload condition missing';
  end if;
  definition := replace(definition, old_condition, new_condition);
  execute 'create or replace view app.v_deliverer_workload as ' || definition;
end $$;


-- ▼▼▼ 20261007215429_unify_amazon_return_work_status.sql ▼▼▼

-- Amazon返品 is a supplier category, not a work status.
-- Apply the same work-status rules to every supplier, without return dates.
create or replace function app.items_sync_status()
returns trigger language plpgsql set search_path = 'pg_catalog', 'app' as $$
begin
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$$;

-- A historical Amazon-return marker must not prevent a new sale.
create or replace function app.items_mark_sold()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status = '販売済'
     and old.status in ('返品処理', '販売済')
     and new.returned_on is not null
     and new.returned_on is not distinct from old.returned_on then return new; end if;
  if new.sold_on is not null and not new.is_accessory and new.status <> '返品処理' then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then new.status := '返品処理'; end if;
  return new;
end;
$$;

-- Change only the retired state. Retain supplier, source history and dates.
do $$ begin
  if exists(select 1 from app.items where status='Amazon返品' and marketplace is distinct from 'Amazon返品') then
    raise exception 'Unexpected supplier for retired Amazon-return status';
  end if;
end $$;
update app.items set status = case
  when sold_on is not null and (sold_price is not null or is_accessory) then '販売済'::app.item_status
  when shipped_on is not null then '出品中'::app.item_status
  else '作業中'::app.item_status end
where status = 'Amazon返品';

do $$
declare definition text;
begin
  definition := pg_get_viewdef('app.v_deliverer_workload'::regclass,true);
  definition := replace(definition,
    'i.status = ''作業中''::app.item_status OR i.status = ''Amazon返品''::app.item_status AND i.shipped_on IS NULL',
    'i.status = ''作業中''::app.item_status');
  if position('Amazon返品' in definition)>0 then raise exception 'Unexpected workload definition'; end if;
  execute 'create or replace view app.v_deliverer_workload as '||definition;
  definition := pg_get_viewdef('app.v_delivery_tasks'::regclass,true);
  definition := replace(definition,'''Amazon返品''::app.item_status, ','');
  execute 'create or replace view app.v_delivery_tasks as '||definition;
end $$;
alter table app.items add constraint items_no_amazon_return_work_status
  check(status <> 'Amazon返品'::app.item_status);

-- Keep Amazon sale reconciliation tied to the supplier category after retiring
-- its old work-status marker. Preserve all other matching/authorization logic.
do $$
declare definition text; old_condition text;
begin
  definition := pg_get_functiondef('app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid)'::regprocedure);
  old_condition := '(amazon_returned_on is not null or returned_on is not null or status in (''Amazon返品'',''返品処理''))';
  if position(old_condition in definition)=0 then raise exception 'Expected sale reconciliation condition missing'; end if;
  definition := replace(definition,old_condition,
    '(marketplace = ''Amazon返品'' or amazon_returned_on is not null or returned_on is not null or status in (''Amazon返品'',''返品処理''))');
  execute definition;
end $$;


-- ▼▼▼ 20261007232218_remove_arrival_and_unify_workload.sql ▼▼▼

-- Remove the retired arrival concept and unify work metrics.
CREATE OR REPLACE FUNCTION app.set_delivery_progress(p_item_id uuid, p_step text, p_done boolean, p_on date DEFAULT NULL::date)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false)
   and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' and not coalesce(photo_exempt,false) then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $function$
;

CREATE OR REPLACE FUNCTION app.set_work_progress(p_item_id uuid, p_step text, p_done boolean DEFAULT true)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_item app.items;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  if p_step not in ('registered','inspected','photo','packed','shipped') then
    raise exception '作業項目を確認してください' using errcode='22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  if p_done and p_step in ('packed','shipped') then perform app.require_photo_review(p_item_id); end if;
  update app.items set
    product_registered_at = case when p_step='registered' then case when p_done then now() else null end else product_registered_at end,
    inspected_at = case when p_step='inspected' then case when p_done then now() else null end else inspected_at end,
    photo_uploaded_at = case when p_step='photo' then case when p_done then now() else null end else photo_uploaded_at end,
    packed_on = case when p_step='packed' then case when p_done then current_date else null end else packed_on end,
    shipped_on = case when p_step='shipped' then case when p_done then current_date else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end $function$
;

CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app'
AS $function$
begin
  if new.status in ('返品処理', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.apply_amazon_sale(p_account text, p_transaction text, p_sku text, p_asin text, p_sold_on date, p_price bigint, p_payout bigint, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_count integer; serial_key text; root_serial text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status='RELEASED';
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  serial_key:=app.product_serial(p_sku,null);
  root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
  if serial_key is null then return jsonb_build_object('status','review','reason','SKUの商品番号を読み取れません。'); end if;
  -- Any returned row wins over the original SKU, even when Amazon reports only
  -- the numeric SKU. Suffix depth orders 100, 100a, 100aa chronologically.
  select id into target_id from app.items
   where not is_accessory and (regexp_match(sku,'^([0-9]+)'))[1]=root_serial
     and (marketplace = 'Amazon返品' or amazon_returned_on is not null or returned_on is not null or status in ('Amazon返品','返品処理'))
   order by length(regexp_replace(app.product_serial(sku,lot_seq),'^[0-9]+','')) desc,
            coalesce(amazon_returned_on,returned_on) desc nulls last, updated_at desc, id desc
   limit 1;
  if target_id is null then
    select id into target_id from app.items where sku=p_sku and not is_accessory order by id limit 1;
  end if;
  if target_id is null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items
      where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then target_id:=null; end if;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・返品在庫が見つかりません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','仕入日より前の販売のため確認が必要です。'); end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif inventory.sold_on is not null or inventory.sold_price is not null or inventory.payout_amount is not null then
    return jsonb_build_object('status','review','reason','対象の返品行に既存の販売記録があります。上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout,status='販売済' where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を返品後の在庫行に反映しました。','item_id',inventory.id);
end; $function$
;

CREATE OR REPLACE FUNCTION app.guard_single_product_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then
    return new;
  end if;
  if new.sold_on is null
     or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then
    return new;
  end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id
      and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null
      and i.returned_on is null
      and i.marketplace is distinct from 'Amazon返品'
      and i.status not in ('Amazon返品','返品処理')
  ) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.redirect_accessory_shared_edits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare parent app.items%rowtype; parent_count integer;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.returned_on is distinct from old.returned_on
    or new.sales_channel is distinct from old.sales_channel or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
  ) then return new; end if;
  select count(*) into parent_count from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  -- A standalone sold accessory has no shared parent to update. Permit only
  -- an authenticated administrator to fill its blank historical work dates.
  if parent_count=0 and auth.uid() is not null and coalesce(app.is_admin(),false)
    and old.status='販売済' and new.status=old.status
    and (old.packed_on is null or new.packed_on is not distinct from old.packed_on)
    and (old.shipped_on is null or new.shipped_on is not distinct from old.shipped_on)
    and new.packed_on is not null and new.shipped_on is not null
    and new.packed_on<=new.shipped_on
    -- The generated profit column is evaluated after BEFORE triggers.
    and (to_jsonb(new)-array['packed_on','shipped_on','packed_completed_at','updated_at','profit'])
      is not distinct from
      (to_jsonb(old)-array['packed_on','shipped_on','packed_completed_at','updated_at','profit']) then
    return new;
  end if;
  if parent_count <> 1 then raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください'; end if;
  select i.* into parent from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq)
   for update;
  update app.items i set
    status=case when new.status is distinct from old.status then new.status else parent.status end,
    packed_on=case when new.packed_on is distinct from old.packed_on then new.packed_on else parent.packed_on end,
    shipped_on=case when new.shipped_on is distinct from old.shipped_on then new.shipped_on else parent.shipped_on end,
    returned_on=case when new.returned_on is distinct from old.returned_on then new.returned_on else parent.returned_on end,
    sales_channel=case when new.sales_channel is distinct from old.sales_channel then new.sales_channel else parent.sales_channel end,
    sold_on=case when new.sold_on is distinct from old.sold_on then new.sold_on else parent.sold_on end,
    sold_price=case when new.sold_price is distinct from old.sold_price then new.sold_price else parent.sold_price end,
    payout_amount=case when new.payout_amount is distinct from old.payout_amount then new.payout_amount else parent.payout_amount end
  where i.id=parent.id;
  select i.* into parent from app.items i where i.id=parent.id;
  new.status:=parent.status;
  new.packed_on:=parent.packed_on;
  new.shipped_on:=parent.shipped_on;
  new.returned_on:=parent.returned_on;
  new.sales_channel:=parent.sales_channel;
  new.sold_on:=parent.sold_on;
  new.sold_price:=null;
  new.payout_amount:=null;
  return new;
end;
$function$

;

drop trigger items_sync_status on app.items;
create trigger items_sync_status before insert or update of status, product_registered_at,
  inspected_at, cleaned_at, photo_uploaded_at, packed_on, shipped_on, listed_on, amazon_returned_on
  on app.items for each row execute function app.items_sync_status();

do $$ begin
  if exists(select 1 from app.items where status in ('保留','廃棄')) then
    raise exception 'Retired states contain data; reconcile before removing';
  end if;
end $$;
alter table app.items add constraint items_no_hold_or_discard
  check(status not in ('保留','廃棄'));

-- Remove discarded-state exclusions without changing other stock logic.
do $$ declare rec record; definition text; begin
  for rec in select v.viewname,c.reloptions from pg_views v join pg_class c
    on c.oid=('app.'||v.viewname)::regclass where v.schemaname='app' and v.definition like '%廃棄%' loop
    definition := pg_get_viewdef(('app.'||rec.viewname)::regclass,true);
    definition := replace(definition,', ''廃棄''::app.item_status','');
    definition := replace(definition,'''廃棄''::app.item_status, ','');
    if position('廃棄' in definition)>0 then raise exception 'Unexpected view: %',rec.viewname; end if;
    execute 'create or replace view app.'||quote_ident(rec.viewname)||case when rec.reloptions is null then ''
      else ' with ('||array_to_string(rec.reloptions,',')||')' end||' as '||definition;
  end loop;
end $$;

-- Explicitly rebuild only the five dependent views, without CASCADE, retaining
-- owner, security options, comments and original grants.
create temporary table arrival_views_before on commit drop as
select c.relname,c.relowner,c.reloptions,c.relacl,pg_get_viewdef(c.oid,true) as definition,
  obj_description(c.oid,'pg_class') as comment,
  case c.relname when 'v_items' then 1 when 'v_deliverer_workload' then 2
    when 'v_delivery_tasks' then 3 when 'v_inventory_items' then 4
    when 'v_inventory_display' then 5 end as ordinal
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='app' and c.relname in
  ('v_items','v_deliverer_workload','v_delivery_tasks','v_inventory_items','v_inventory_display');

do $$ declare rec record; begin
  if (select count(*) from arrival_views_before)<>5 then raise exception 'Expected five arrival views'; end if;
  for rec in select * from arrival_views_before order by ordinal desc loop
    execute 'drop view app.'||quote_ident(rec.relname);
  end loop;
end $$;
alter table app.items drop column arrived_on;

do $$ declare rec record; privilege_rec record; new_role record; definition text; target text; begin
  for rec in select * from arrival_views_before order by ordinal loop
    definition := regexp_replace(rec.definition,'[ \t]*(i|inventory)\.arrived_on,\n','','g');
    if rec.relname='v_deliverer_workload' then
      definition := $view$
        select s.id as deliverer_id,s.name as deliverer_name,
          count(*) filter(where i.status='作業中') as 作業中,
          count(*) filter(where i.shipped_on>=date_trunc('month',current_date::timestamptz)) as 今月出荷,
          count(*) filter(where i.status='作業中') as 手元在庫,
          avg(i.shipped_on-i.purchased_at) filter(where i.shipped_on is not null and i.purchased_at is not null)::numeric(10,1) as 平均作業日数
        from app.staff s join app.items i on i.deliverer_id=s.id where s.is_active
        group by s.id,s.name order by count(*) filter(where i.status='作業中') desc
      $view$;
    end if;
    if position('arrived_on' in definition)>0 then raise exception 'Arrival reference remains: %',rec.relname; end if;
    target := 'app.'||quote_ident(rec.relname);
    execute 'create view '||target||case when rec.reloptions is null then ''
      else ' with ('||array_to_string(rec.reloptions,',')||')' end||' as '||definition;
    execute 'alter view '||target||' owner to '||quote_ident(pg_get_userbyid(rec.relowner));
    -- Remove newly inherited default grants before restoring the originals.
    for new_role in select distinct a.grantee from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid=target::regclass and a.grantee<>rec.relowner loop
      execute 'revoke all on '||target||' from '||case when new_role.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(new_role.grantee)) end;
    end loop;
    execute 'revoke all on '||target||' from PUBLIC';
    for privilege_rec in select * from aclexplode(coalesce(rec.relacl,acldefault('r',rec.relowner))) where grantee<>rec.relowner loop
      execute 'grant '||privilege_rec.privilege_type||' on '||target||' to '||
        case when privilege_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege_rec.grantee)) end||
        case when privilege_rec.is_grantable then ' with grant option' else '' end;
    end loop;
    if rec.comment is not null then execute 'comment on view '||target||' is '||quote_literal(rec.comment); end if;
  end loop;
end $$;


-- ▼▼▼ 20261008002317_integrate_delivery_listing_progress.sql ▼▼▼

-- Shared handler for the displayed 商品登録・写真登録 step.
-- p_done NULL records a successful photo upload without completing product registration.
create function app.set_delivery_listing_progress(p_item_id uuid,p_done boolean default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 perform app.assert_can_work_on(p_item_id);
 if p_done is null and not exists(select 1 from app.item_photos where item_id=p_item_id) then
   raise exception 'アップロード済みの写真がありません' using errcode='22023';
 end if;
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 update app.items set
   product_registered_at=case when p_done is null then product_registered_at
     when p_done then coalesce(product_registered_at,now()) else null end,
   photo_uploaded_at=case when p_done is null then coalesce(photo_uploaded_at,now())
     when photo_exempt then photo_uploaded_at
     when p_done then coalesce(photo_uploaded_at,now()) else null end
 where id=p_item_id returning * into result;
 return result;
end $$;
revoke all on function app.set_delivery_listing_progress(uuid,boolean) from public,anon;
grant execute on function app.set_delivery_listing_progress(uuid,boolean) to authenticated;
CREATE OR REPLACE FUNCTION app.set_delivery_progress(p_item_id uuid, p_step text, p_done boolean, p_on date DEFAULT NULL::date)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result app.items; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 if p_step='listing' then return app.set_delivery_listing_progress(p_item_id,p_done);end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false)
   and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $function$
;
create or replace function app.set_work_progress(p_item_id uuid,p_step text,p_done boolean default true)
returns app.items language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_step<>'photo' or p_done is distinct from true then
   raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 return app.set_delivery_listing_progress(p_item_id,null);
end $$;


-- ▼▼▼ 20261008002324_remove_retired_item_status_enum.sql ▼▼▼

-- Replace the enum transactionally; preserve every item's data and permissions.
set local lock_timeout='5s';
create temporary table status_items_before on commit drop as select id,to_jsonb(i) as value from app.items i;
create temporary table status_type_before on commit drop as
select typowner,typacl,obj_description(oid,'pg_type') as comment from pg_type where oid='app.item_status'::regtype;
do $$ begin
 if exists(select 1 from app.items where status::text not in ('作業中','出品中','販売済','返品処理')) then
   raise exception 'Legacy status data requires reconciliation';end if;
end $$;
CREATE OR REPLACE FUNCTION app.apply_amazon_sale(p_account text, p_transaction text, p_sku text, p_asin text, p_sold_on date, p_price bigint, p_payout bigint, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_count integer; serial_key text; root_serial text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status='RELEASED';
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  serial_key:=app.product_serial(p_sku,null);
  root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
  if serial_key is null then return jsonb_build_object('status','review','reason','SKUの商品番号を読み取れません。'); end if;
  -- Any returned row wins over the original SKU, even when Amazon reports only
  -- the numeric SKU. Suffix depth orders 100, 100a, 100aa chronologically.
  select id into target_id from app.items
   where not is_accessory and (regexp_match(sku,'^([0-9]+)'))[1]=root_serial
     and (marketplace = 'Amazon返品' or amazon_returned_on is not null or returned_on is not null or status='返品処理')
   order by length(regexp_replace(app.product_serial(sku,lot_seq),'^[0-9]+','')) desc,
            coalesce(amazon_returned_on,returned_on) desc nulls last, updated_at desc, id desc
   limit 1;
  if target_id is null then
    select id into target_id from app.items where sku=p_sku and not is_accessory order by id limit 1;
  end if;
  if target_id is null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items
      where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then target_id:=null; end if;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・返品在庫が見つかりません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','仕入日より前の販売のため確認が必要です。'); end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif inventory.sold_on is not null or inventory.sold_price is not null or inventory.payout_amount is not null then
    return jsonb_build_object('status','review','reason','対象の返品行に既存の販売記録があります。上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout,status='販売済' where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を返品後の在庫行に反映しました。','item_id',inventory.id);
end; $function$
;

CREATE OR REPLACE FUNCTION app.guard_single_product_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then
    return new;
  end if;
  if new.sold_on is null
     or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then
    return new;
  end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id
      and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null
      and i.returned_on is null
      and i.marketplace is distinct from 'Amazon返品'
      and i.status<>'返品処理'
  ) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION app.enforce_amazon_return_main_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  numeric_serial text;
  separator_and_tail text;
  requested_depth integer;
  existing_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then
    return new;
  end if;

  -- A reserve recovered from an Amazon return remains an accessory when
  -- registered together with its explicitly allocated main item. All source
  -- identity fields must match; ordinary return registrations stay main items.
  if tg_op = 'INSERT' and new.is_accessory and new.work_stream::text = '付属品'
    and auth.uid() is not null and app.current_role() in ('admin','purchaser')
    and exists (
      select 1 from app.spare_accessories s join app.items i on i.id=s.used_for_item_id
      where not i.is_accessory and i.lot_seq=new.lot_seq
        and i.created_by=app.current_staff_id()
        and i.deliverer_id is not distinct from new.deliverer_id
        and s.title is not distinct from new.title
        and s.marketplace_item_id is not distinct from new.marketplace_item_id
        and s.asin is not distinct from new.asin
        and s.cost_amount is not distinct from new.cost_amount
        and s.purchased_at is not distinct from new.purchased_at
        and new.purchaser_id is not distinct from coalesce(s.owner_staff_id,i.purchaser_id)
        and (app.is_admin() or s.owner_staff_id=app.current_staff_id())
    ) then return new; end if;

  if tg_op <> 'INSERT' then
    if new.amazon_returned_on is not null then
      new.is_accessory := false;
    end if;
    return new;
  end if;

  new.is_accessory := false;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if numeric_serial is null or separator_and_tail is null then
    return new;
  end if;

  -- Serialize return registrations for a product so concurrent submissions
  -- cannot receive the same suffix.
  perform pg_advisory_xact_lock(hashtextextended('amazon-return:' || new.lot_seq::text || ':' || numeric_serial, 179049));

  select coalesce(max(length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''))), 0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and (regexp_match(i.sku, '^([0-9]+)'))[1] = numeric_serial;

  requested_depth := length(coalesce((regexp_match(new.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  return new;
end;
$function$
;

create temporary table status_views_before on commit drop as
with recursive dependent_views(oid,depth) as (
 select r.ev_class,1 from pg_depend d join pg_rewrite r on d.classid='pg_rewrite'::regclass and r.oid=d.objid
 where d.refclassid='pg_class'::regclass and d.refobjid='app.items'::regclass
   and d.refobjsubid=(select attnum from pg_attribute where attrelid='app.items'::regclass and attname='status')
 union all
 select r.ev_class,b.depth+1 from dependent_views b join pg_depend d on d.refclassid='pg_class'::regclass and d.refobjid=b.oid
 join pg_rewrite r on d.classid='pg_rewrite'::regclass and r.oid=d.objid where r.ev_class<>b.oid
), depths as (select oid,max(depth) as depth from dependent_views group by oid)
select c.relname,c.relowner,c.relacl,c.reloptions,pg_get_viewdef(c.oid,true) as definition,
 obj_description(c.oid,'pg_class') as comment,d.depth
from depths d join pg_class c on c.oid=d.oid where c.relnamespace='app'::regnamespace and c.relkind='v';
do $$ declare rec record; begin
 if (select count(*) from status_views_before)<>9 then raise exception 'Expected nine dependent views';end if;
 for rec in select * from status_views_before order by depth desc,relname loop
   execute 'drop view app.'||quote_ident(rec.relname);
 end loop;
end $$;
create temporary table status_triggers_before on commit drop as
select tgname,pg_get_triggerdef(oid) as definition,tgenabled from pg_trigger
where tgrelid='app.items'::regclass and tgname in
 ('items_redirect_accessory_shared_edits','items_sync_accessory_sale_date','items_sync_status');
do $$ declare rec record; begin
 if (select count(*) from status_triggers_before)<>3 then raise exception 'Expected three status triggers';end if;
 for rec in select * from status_triggers_before loop execute 'drop trigger '||quote_ident(rec.tgname)||' on app.items';end loop;
end $$;
alter table app.items drop constraint items_no_hold_or_discard,
 drop constraint items_no_retired_purchase_status,drop constraint items_no_amazon_return_work_status;
alter table app.items alter column status drop default;
create type app.item_status_current as enum ('作業中','出品中','販売済','返品処理');
alter table app.items alter column status type app.item_status_current using status::text::app.item_status_current;
drop type app.item_status;
alter type app.item_status_current rename to item_status;
alter table app.items alter column status set default '作業中'::app.item_status;
do $$ declare saved record; role_rec record; grant_rec record; begin
 select * into saved from status_type_before;
 execute 'alter type app.item_status owner to '||quote_ident(pg_get_userbyid(saved.typowner));
 if saved.typacl is not null then
 for role_rec in select distinct a.grantee from pg_type t,
   lateral aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a
   where t.oid='app.item_status'::regtype and a.grantee<>saved.typowner loop
   execute 'revoke all on type app.item_status from '||case when role_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(role_rec.grantee)) end;
 end loop;
 for grant_rec in select * from aclexplode(coalesce(saved.typacl,acldefault('T',saved.typowner))) where grantee<>saved.typowner loop
   execute 'grant '||grant_rec.privilege_type||' on type app.item_status to '||case when grant_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_rec.grantee)) end||case when grant_rec.is_grantable then ' with grant option' else '' end;
 end loop;
 elsif (select typacl is not null from pg_type where oid='app.item_status'::regtype) then
   raise exception 'Unexpected default type grants';
 end if;
 if saved.comment is not null then execute 'comment on type app.item_status is '||quote_literal(saved.comment);end if;
end $$;
do $$ declare rec record; definition text; target text; role_rec record; grant_rec record; begin
 for rec in select * from status_views_before order by depth,relname loop
   definition:=replace(rec.definition,', ''出荷済''::app.item_status','');
   if definition like '%出荷済%' then raise exception 'Legacy shipping state remains: %',rec.relname;end if;
   target:='app.'||quote_ident(rec.relname);
   execute 'create view '||target||case when rec.reloptions is null then '' else ' with ('||array_to_string(rec.reloptions,',')||')' end||' as '||definition;
   execute 'alter view '||target||' owner to '||quote_ident(pg_get_userbyid(rec.relowner));
   for role_rec in select distinct a.grantee from pg_class c,
     lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     where c.oid=target::regclass and a.grantee<>rec.relowner loop
     execute 'revoke all on '||target||' from '||case when role_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(role_rec.grantee)) end;
   end loop;
   execute 'revoke all on '||target||' from PUBLIC';
   for grant_rec in select * from aclexplode(coalesce(rec.relacl,acldefault('r',rec.relowner))) where grantee<>rec.relowner loop
     execute 'grant '||grant_rec.privilege_type||' on '||target||' to '||case when grant_rec.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_rec.grantee)) end||case when grant_rec.is_grantable then ' with grant option' else '' end;
   end loop;
   if rec.comment is not null then execute 'comment on view '||target||' is '||quote_literal(rec.comment);end if;
 end loop;
 for rec in select * from status_triggers_before loop
   execute rec.definition;
   execute 'alter table app.items '||case rec.tgenabled when 'D' then 'disable' when 'R' then 'enable replica' when 'A' then 'enable always' else 'enable' end||' trigger '||quote_ident(rec.tgname);
 end loop;
end $$;
drop function app.set_work_progress(uuid,text,boolean);
do $$ begin
 if exists(select 1 from app.items i full join status_items_before b using(id) where to_jsonb(i) is distinct from b.value) then
   raise exception 'Inventory data changed during type replacement';end if;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261008015402_enforce_delivery_view_invoker.sql ▼▼▼

-- Read as the logged-in user and restrict delivery inventory to their assignment.
-- Administrators retain the existing all-staff overview.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
SELECT i.id,
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
        CASE
            WHEN i.is_accessory THEN shared.sales_channel
            ELSE i.sales_channel
        END AS sales_channel,
    i.planned_price,
    i.deliverer_id,
    buyer.name AS purchaser_name,
    i.product_registered_at IS NOT NULL AS product_registered,
    i.inspected_at IS NOT NULL AS inspected,
    i.photo_uploaded_at IS NOT NULL AS photo_uploaded,
    i.packed_on,
    i.shipped_on,
    i.amazon_returned_on,
    COALESCE(NULLIF(btrim(p.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS reference_image_url,
    ( SELECT count(*) AS count
           FROM app.item_photos ph
          WHERE ph.item_id = i.id) AS photo_count,
    ( SELECT max(cm.created_at) AS max
           FROM app.item_comments cm
          WHERE cm.item_id = i.id) AS last_comment_at,
    i.cleaned_at IS NOT NULL AS cleaned,
    i.description_template,
    i.manufacture_year,
    i.marketplace_item_id,
    p.model_no,
    i.malfunction_reported,
    i.malfunction_comment,
    i.malfunction_reported_at,
    i.malfunction_resolved_at,
        CASE
            WHEN i.is_accessory THEN shared.sold_price
            ELSE i.sold_price
        END AS sold_price,
        CASE
            WHEN i.is_accessory THEN shared.payout_amount
            ELSE i.payout_amount
        END AS payout_amount,
    i.marketplace_url
   FROM app.items i
     LEFT JOIN app.products p ON p.id = i.product_id OR i.product_id IS NULL AND i.marketplace::text = '動作品Amazon返品'::text AND p.asin = i.asin
     LEFT JOIN app.products asin_product ON asin_product.asin = i.asin
     LEFT JOIN app.staff buyer ON buyer.id = i.purchaser_id
     LEFT JOIN LATERAL app.shared_product_sale_values(i.id) shared(sales_channel, sold_price, payout_amount) ON true
  WHERE i.status = ANY (ARRAY['作業中'::app.item_status, '返品処理'::app.item_status, '出品中'::app.item_status, '販売済'::app.item_status]) AND (app.is_admin() OR i.deliverer_id = app.current_staff_id());
notify pgrst, 'reload schema';


-- ▼▼▼ 20261008023112_workload_main_packed_three_months.sql ▼▼▼

-- Keep the existing column order and 今月出荷 compatibility alias for old clients.
create or replace view app.v_deliverer_workload as
with dates as (
 select (now() at time zone 'Asia/Tokyo')::date as today,
 date_trunc('month',now() at time zone 'Asia/Tokyo')::date as month_start,
 ((now() at time zone 'Asia/Tokyo')::date - interval '3 months')::date as average_start
)
select s.id as deliverer_id,s.name as deliverer_name,
 count(*) filter(where not i.is_accessory and i.status='作業中') as "作業中",
 count(*) filter(where not i.is_accessory and i.shipped_on between d.month_start and d.today) as "今月出荷",
 count(*) filter(where not i.is_accessory and i.status='作業中') as "手元在庫",
 avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null
   and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数",
 count(*) filter(where not i.is_accessory and i.packed_on between d.month_start and d.today) as "梱包済",
 count(*) filter(where not i.is_accessory and i.shipped_on between d.month_start and d.today) as "出荷済"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active group by s.id,s.name
order by count(*) filter(where not i.is_accessory and i.status='作業中') desc;
notify pgrst,'reload schema';


-- ▼▼▼ 20261008070550_distinguish_yahoo_spare_serial_suffix.sql ▼▼▼

-- Preserve full serial identity, including a/aa suffixes; no existing data backfill.
create or replace function app.move_inventory_accessory_to_spares(
  p_item_id uuid,
  p_spare_input jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item app.items%rowtype;
  v_spare_id uuid;
  v_owner_id uuid;
  v_owner_name text;
  v_registered_serial text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備一覧へ登録する権限がありません' using errcode='42501';
  end if;
  if p_spare_input is null or jsonb_typeof(p_spare_input) <> 'object' then
    raise exception 'リモコン情報が不正です' using errcode='22023';
  end if;

  select * into v_item from app.items where id=p_item_id for update;
  if not found then raise exception '在庫一覧のリモコン行が見つかりません' using errcode='P0002'; end if;
  if not v_item.is_accessory or v_item.title not ilike '%リモコン%' then
    raise exception '対象は付属品登録されたリモコン行ではありません' using errcode='22023';
  end if;
  if app.current_role() = 'purchaser' and v_item.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外のリモコン行は移動できません' using errcode='42501';
  end if;
  if coalesce(p_spare_input->>'usage_note','') !~ '^[0-9]+[a-z]*$' then
    raise exception '利用記録に通番号を入力してください' using errcode='22023';
  end if;
  v_registered_serial := upper(p_spare_input->>'usage_note');
  if v_registered_serial is distinct from app.product_serial(v_item.sku,v_item.lot_seq) then
    raise exception '入力した通番号と在庫行の通番号が一致しません' using errcode='22023';
  end if;

  v_owner_id := coalesce(nullif(p_spare_input->>'owner_staff_id','')::uuid, v_item.purchaser_id, app.current_staff_id());
  if app.current_role() = 'purchaser' and v_owner_id is distinct from app.current_staff_id() then
    raise exception '自分の予備としてのみ登録できます' using errcode='42501';
  end if;
  select name into v_owner_name from app.staff where id=v_owner_id;
  v_owner_name := coalesce(nullif(btrim(p_spare_input->>'owner_name'),''),v_owner_name);
  if nullif(btrim(p_spare_input->>'title'),'') is null then
    raise exception '品名を入力してください' using errcode='22023';
  end if;
  if coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount) < 0 then
    raise exception '仕入金額は0円以上で入力してください' using errcode='22023';
  end if;

  insert into app.spare_accessories (
    source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
    cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
  ) values (
    coalesce(nullif(p_spare_input->>'source_sku',''),v_item.sku),
    v_owner_id,v_owner_name,
    coalesce(nullif(p_spare_input->>'purchased_at','')::date,v_item.purchased_at),
    btrim(p_spare_input->>'title'),
    nullif(btrim(p_spare_input->>'manufacturer'),''),
    nullif(btrim(p_spare_input->>'model_no'),''),
    nullif(btrim(p_spare_input->>'asin'),''),
    coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount),
    nullif(p_spare_input->>'marketplace',''),
    nullif(p_spare_input->>'marketplace_item_id',''),
    nullif(p_spare_input->>'tracking_no',''),
    p_spare_input->>'usage_note'
  ) returning id into v_spare_id;

  delete from app.items where id=v_item.id;
  return v_spare_id;
end;
$$;

revoke all on function app.move_inventory_accessory_to_spares(uuid,jsonb) from public,anon;
grant execute on function app.move_inventory_accessory_to_spares(uuid,jsonb) to authenticated;

create or replace function app.prepare_yahoo_auction_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body app.items%rowtype;
  v_remote app.items%rowtype;
  v_remote_count integer;
  v_owner_id uuid;
  v_owner_name text;
  v_model_no text;
  v_maker text;
  v_serial text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception 'ヤフオク販売の準備を行う権限がありません' using errcode='42501';
  end if;

  select * into v_body from app.items where id=p_item_id for update;
  if not found then raise exception '対象の在庫行が見つかりません' using errcode='P0002'; end if;
  if v_body.is_accessory then raise exception '本体の在庫行を選択してください' using errcode='22023'; end if;
  if app.current_role() = 'purchaser' and v_body.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外の商品はヤフオク販売に設定できません' using errcode='42501';
  end if;

  v_serial := lower(app.product_serial(v_body.sku,v_body.lot_seq));

  update app.items set sales_channel='ヤフオク'::app.sales_channel, updated_at=now() where id=v_body.id;

  if exists (
    select 1 from app.spare_accessories s
    where lower(btrim(s.usage_note))=v_serial and s.title ilike '%リモコン%'
  ) then
    return;
  end if;

  select count(*) into v_remote_count from app.items i
  where app.product_serial(i.sku,i.lot_seq)=app.product_serial(v_body.sku,v_body.lot_seq) and i.is_accessory and i.title ilike '%リモコン%';
  if v_remote_count > 1 then
    raise exception '通番号 % のリモコン行が複数あります。在庫一覧を確認してください。', v_serial using errcode='22023';
  end if;

  if v_remote_count = 1 then
    select * into v_remote from app.items i
    where app.product_serial(i.sku,i.lot_seq)=app.product_serial(v_body.sku,v_body.lot_seq) and i.is_accessory and i.title ilike '%リモコン%'
    limit 1 for update;
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_remote.product_id;
    v_owner_id := coalesce(v_remote.purchaser_id,v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    perform app.move_inventory_accessory_to_spares(v_remote.id,jsonb_build_object(
      'source_sku',v_remote.sku,
      'owner_staff_id',v_owner_id,
      'owner_name',v_owner_name,
      'purchased_at',v_remote.purchased_at,
      'title',v_remote.title,
      'manufacturer',v_maker,
      'model_no',v_model_no,
      'asin',v_remote.asin,
      'cost_amount',v_remote.cost_amount,
      'marketplace',v_remote.marketplace,
      'marketplace_item_id',v_remote.marketplace_item_id,
      'tracking_no',v_remote.tracking_no,
      'usage_note',v_serial
    ));
  else
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_body.product_id;
    v_owner_id := coalesce(v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    insert into app.spare_accessories (
      source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
      cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
    ) values (
      null,v_owner_id,v_owner_name,v_body.purchased_at,'リモコン',v_maker,v_model_no,v_body.asin,
      0,v_body.marketplace,v_body.marketplace_item_id,v_body.tracking_no,v_serial
    );
  end if;
end;
$$;

revoke all on function app.prepare_yahoo_auction_item(uuid) from public, anon;
grant execute on function app.prepare_yahoo_auction_item(uuid) to authenticated;


-- ▼▼▼ 20261008093808_display_purchaser_comments_delivery.sql ▼▼▼

-- Read as the logged-in user and restrict delivery inventory to their assignment.
-- Administrators retain the existing all-staff overview.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
SELECT i.id,
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
        CASE
            WHEN i.is_accessory THEN shared.sales_channel
            ELSE i.sales_channel
        END AS sales_channel,
    i.planned_price,
    i.deliverer_id,
    buyer.name AS purchaser_name,
    i.product_registered_at IS NOT NULL AS product_registered,
    i.inspected_at IS NOT NULL AS inspected,
    i.photo_uploaded_at IS NOT NULL AS photo_uploaded,
    i.packed_on,
    i.shipped_on,
    i.amazon_returned_on,
    COALESCE(NULLIF(btrim(p.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS reference_image_url,
    ( SELECT count(*) AS count
           FROM app.item_photos ph
          WHERE ph.item_id = i.id) AS photo_count,
    ( SELECT max(cm.created_at) AS max
           FROM app.item_comments cm
          WHERE cm.item_id = i.id) AS last_comment_at,
    i.cleaned_at IS NOT NULL AS cleaned,
    i.description_template,
    i.manufacture_year,
    i.marketplace_item_id,
    p.model_no,
    i.malfunction_reported,
    i.malfunction_comment,
    i.malfunction_reported_at,
    i.malfunction_resolved_at,
        CASE
            WHEN i.is_accessory THEN shared.sold_price
            ELSE i.sold_price
        END AS sold_price,
        CASE
            WHEN i.is_accessory THEN shared.payout_amount
            ELSE i.payout_amount
        END AS payout_amount,
    i.marketplace_url
   FROM app.items i
     LEFT JOIN app.products p ON p.id = i.product_id OR i.product_id IS NULL AND i.marketplace::text = '動作品Amazon返品'::text AND p.asin = i.asin
     LEFT JOIN app.products asin_product ON asin_product.asin = i.asin
     LEFT JOIN app.staff buyer ON buyer.id = i.purchaser_id
     LEFT JOIN LATERAL app.shared_product_sale_values(i.id) shared(sales_channel, sold_price, payout_amount) ON true
  WHERE i.status = ANY (ARRAY['作業中'::app.item_status, '返品処理'::app.item_status, '出品中'::app.item_status, '販売済'::app.item_status]) AND (app.is_admin() OR i.deliverer_id = app.current_staff_id());
notify pgrst, 'reload schema';


-- ▼▼▼ 20261008094109_expose_purchaser_memo.sql ▼▼▼

-- Read as the logged-in user and restrict delivery inventory to their assignment.
-- Administrators retain the existing all-staff overview.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
SELECT i.id,
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
        CASE
            WHEN i.is_accessory THEN shared.sales_channel
            ELSE i.sales_channel
        END AS sales_channel,
    i.planned_price,
    i.deliverer_id,
    buyer.name AS purchaser_name,
    i.product_registered_at IS NOT NULL AS product_registered,
    i.inspected_at IS NOT NULL AS inspected,
    i.photo_uploaded_at IS NOT NULL AS photo_uploaded,
    i.packed_on,
    i.shipped_on,
    i.amazon_returned_on,
    COALESCE(NULLIF(btrim(p.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS reference_image_url,
    ( SELECT count(*) AS count
           FROM app.item_photos ph
          WHERE ph.item_id = i.id) AS photo_count,
    ( SELECT max(cm.created_at) AS max
           FROM app.item_comments cm
          WHERE cm.item_id = i.id) AS last_comment_at,
    i.cleaned_at IS NOT NULL AS cleaned,
    i.description_template,
    i.manufacture_year,
    i.marketplace_item_id,
    p.model_no,
    i.malfunction_reported,
    i.malfunction_comment,
    i.malfunction_reported_at,
    i.malfunction_resolved_at,
        CASE
            WHEN i.is_accessory THEN shared.sold_price
            ELSE i.sold_price
        END AS sold_price,
        CASE
            WHEN i.is_accessory THEN shared.payout_amount
            ELSE i.payout_amount
        END AS payout_amount,
    i.marketplace_url,
    i.memo
   FROM app.items i
     LEFT JOIN app.products p ON p.id = i.product_id OR i.product_id IS NULL AND i.marketplace::text = '動作品Amazon返品'::text AND p.asin = i.asin
     LEFT JOIN app.products asin_product ON asin_product.asin = i.asin
     LEFT JOIN app.staff buyer ON buyer.id = i.purchaser_id
     LEFT JOIN LATERAL app.shared_product_sale_values(i.id) shared(sales_channel, sold_price, payout_amount) ON true
  WHERE i.status = ANY (ARRAY['作業中'::app.item_status, '返品処理'::app.item_status, '出品中'::app.item_status, '販売済'::app.item_status]) AND (app.is_admin() OR i.deliverer_id = app.current_staff_id());
notify pgrst, 'reload schema';


-- ▼▼▼ 20261008100231_workload_before_packing.sql ▼▼▼

-- Keep the existing column order and 今月出荷 compatibility alias for old clients.
create or replace view app.v_deliverer_workload as
with dates as (
 select (now() at time zone 'Asia/Tokyo')::date as today,
 date_trunc('month',now() at time zone 'Asia/Tokyo')::date as month_start,
 ((now() at time zone 'Asia/Tokyo')::date - interval '3 months')::date as average_start
)
select s.id as deliverer_id,s.name as deliverer_name,
 count(*) filter(where not i.is_accessory and i.status='作業中') as "作業中",
 count(*) filter(where not i.is_accessory and i.shipped_on between d.month_start and d.today) as "今月出荷",
 count(*) filter(where not i.is_accessory and i.status='作業中') as "手元在庫",
 avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null
   and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数",
 count(*) filter(where not i.is_accessory and i.packed_on between d.month_start and d.today) as "梱包済",
 count(*) filter(where not i.is_accessory and i.shipped_on between d.month_start and d.today) as "出荷済",
 count(*) filter(where not i.is_accessory and i.packed_on is null) as "梱包前"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active group by s.id,s.name
order by count(*) filter(where not i.is_accessory and i.status='作業中') desc;
notify pgrst,'reload schema';


-- ▼▼▼ 20261009113000_add_accessory_parent_link.sql ▼▼▼

-- Link accessories to one explicit main item and synchronize the shared inventory fields.
alter table app.items
  add column if not exists parent_item_id uuid references app.items(id) on delete restrict;

create index if not exists items_parent_item_id_idx on app.items(parent_item_id);


create or replace function app.is_standalone_accessory_serial(p_sku text, p_lot_seq integer)
returns boolean
language sql immutable set search_path=''
as 'select coalesce(right(lower(app.product_serial(p_sku,p_lot_seq)),1) = ''c'', false)';

create or replace function app.accessory_sku_for_parent(p_parent_sku text, p_accessory_sku text)
returns text
language plpgsql immutable set search_path=''
as $$
declare
  parent_serial text := app.product_serial(p_parent_sku, null);
  accessory_serial text := app.product_serial(p_accessory_sku, null);
  parent_letters text := coalesce((regexp_match(parent_serial, '^[0-9]+([a-z]*)$'))[1], '');
  accessory_letters text := coalesce((regexp_match(accessory_serial, '^[0-9]+([a-z]*)$'))[1], '');
  suffix text;
  tail text := coalesce(substring(p_parent_sku from '[-_].*$'), substring(p_accessory_sku from '[-_].*$'));
begin
  if parent_serial is null then return p_parent_sku; end if;
  suffix := case
    when parent_letters <> '' and accessory_letters like parent_letters || '%' then substring(accessory_letters from length(parent_letters)+1)
    else accessory_letters
  end;
  if suffix = '' then suffix := 'a'; end if;
  return parent_serial || suffix || tail;
end;
$$;

create or replace function app.keep_accessory_sale_amounts_empty()
returns trigger
language plpgsql security definer set search_path=''
as $$
begin
  if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq)
     and not exists (
    select 1 from app.items p where p.id = new.parent_item_id and not p.is_accessory
  ) then
    new.sold_price := null;
    new.payout_amount := null;
  end if;
  return new;
end;
$$;

create or replace function app.enforce_amazon_return_main_item()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
  parent_id uuid;
  parent_count integer := 0;
  numeric_serial text;
  separator_and_tail text;
  parent_serial text;
  existing_depth integer;
  requested_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then return new; end if;

  if tg_op <> 'INSERT' then
    if new.amazon_returned_on is not null then new.is_accessory := false; end if;
    return new;
  end if;

  if new.is_accessory and new.work_stream::text = '付属品'
     and auth.uid() is not null and app.current_role() in ('admin','purchaser') then
    -- Resolve by the strongest available identity first. Numeric lot alone is used
    -- only when it identifies exactly one main item.
    if new.parent_item_id is not null then
      select p.id into parent_id from app.items p
       where p.id = new.parent_item_id and not p.is_accessory;
      if parent_id is null then
        raise exception '指定した本体が見つかりません。通番号を確認してください' using errcode='22023';
      end if;
    end if;
    if parent_id is null and new.product_id is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.product_id = new.product_id;
    end if;
    if parent_id is null and nullif(new.marketplace_item_id,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_item_id = new.marketplace_item_id;
    end if;
    if parent_id is null and nullif(new.marketplace_url,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_url = new.marketplace_url;
    end if;
    if parent_id is null and nullif(new.asin,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.asin = new.asin and p.title = new.title;
    end if;
    if parent_id is null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p
       where not p.is_accessory and p.lot_seq = new.lot_seq;
    end if;
    if parent_count <> 1 or parent_id is null then
      raise exception '同じ通番号の本体を一意に特定できません。商品ID・ASIN・仕入先URLを確認してください' using errcode='22023';
    end if;
    select * into parent from app.items p where p.id = parent_id for update;
    new.parent_item_id := parent.id;
    new.marketplace_item_id := coalesce(new.marketplace_item_id, parent.marketplace_item_id);
    new.marketplace_url := coalesce(new.marketplace_url, parent.marketplace_url);
    new.product_id := coalesce(new.product_id, parent.product_id);
    new.asin := coalesce(new.asin, parent.asin);
    parent_serial := app.product_serial(parent.sku, parent.lot_seq);
  else
    new.is_accessory := false;
  end if;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if parent_serial is null then parent_serial := numeric_serial; end if;
  if separator_and_tail is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended('amazon-return:'||new.lot_seq::text||':'||coalesce(parent_serial,numeric_serial),179049));

  select coalesce(max(
      case when app.product_serial(i.sku,i.lot_seq) like parent_serial || '%'
           then length(app.product_serial(i.sku,i.lot_seq))-length(parent_serial) else 0 end
    ),0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and i.id <> coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid);

  requested_depth := length(coalesce((regexp_match(new.sku,'^[0-9]+([a-z]*)[-_]'))[1],''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  if new.is_accessory and parent_id is not null then
    new.sku := parent_serial || repeat('a', next_depth) || separator_and_tail;
  else
    new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  end if;
  return new;
end;
$$;

create or replace function app.link_accessory_parent_on_insert()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent_id uuid;
  parent_count integer;
begin
  if not new.is_accessory or new.parent_item_id is not null then return new; end if;
  select count(*), (array_agg(p.id))[1] into parent_count, parent_id
  from app.items p
  where not p.is_accessory and p.lot_seq = new.lot_seq
    and app.product_serial(p.sku,p.lot_seq) = app.product_serial(new.sku,new.lot_seq);
  if parent_count = 0 then
    select count(*), (array_agg(p.id))[1] into parent_count, parent_id
    from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq;
  end if;
  if parent_count > 1 then
    raise exception '同じ通番号の本体が複数あるため、付属品を登録できません。SKUを確認してください' using errcode='22023';
  end if;
  if parent_count = 1 then new.parent_item_id := parent_id; end if;
  return new;
end;
$$;

drop trigger if exists items_link_accessory_parent_on_insert on app.items;
create trigger items_link_accessory_parent_on_insert
  before insert on app.items for each row
  execute function app.link_accessory_parent_on_insert();


notify pgrst, 'reload schema';


-- ▼▼▼ 20261009113100_sync_linked_accessories.sql ▼▼▼

create or replace function app.sync_accessory_sale_date()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  accessory app.items%rowtype;
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  for accessory in
    select a.* from app.items a
    where a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and (
      a.parent_item_id = new.id
      or (a.parent_item_id is null and a.lot_seq = old.lot_seq
          and app.product_serial(a.sku,a.lot_seq) = app.product_serial(old.sku,old.lot_seq))
    )
    for update
  loop
    update app.items set
      parent_item_id = new.id,
      status = new.status,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      sales_channel = new.sales_channel,
      condition = new.condition,
      sold_on = new.sold_on,
      sold_price = new.sold_price,
      payout_amount = new.payout_amount,
      sku = app.accessory_sku_for_parent(new.sku, accessory.sku),
      lot_seq = new.lot_seq,
      deliverer_id = new.deliverer_id
    where id = accessory.id;
  end loop;
  return new;
end;
$$;

create or replace function app.redirect_accessory_shared_edits()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory
     or app.is_standalone_accessory_serial(old.sku,old.lot_seq) then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  select p.* into parent from app.items p
  where not p.is_accessory and (
    p.id = coalesce(new.parent_item_id, old.parent_item_id)
    or (new.parent_item_id is null and old.parent_item_id is null
        and p.lot_seq = old.lot_seq
        and app.product_serial(p.sku,p.lot_seq) = app.product_serial(old.sku,old.lot_seq))
  )
  order by (p.id = coalesce(new.parent_item_id, old.parent_item_id)) desc
  limit 1
  for update;

  if parent.id is null then
    raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください' using errcode='22023';
  end if;

  update app.items set
    status = new.status,
    packed_on = new.packed_on,
    shipped_on = new.shipped_on,
    sales_channel = new.sales_channel,
    condition = new.condition,
    sold_on = new.sold_on,
    sold_price = new.sold_price,
    payout_amount = new.payout_amount,
    lot_seq = new.lot_seq,
    deliverer_id = new.deliverer_id,
    sku = parent.sku
  where id = parent.id;

  select * into parent from app.items where id = parent.id;
  new.parent_item_id := parent.id;
  new.status := parent.status;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.sales_channel := parent.sales_channel;
  new.condition := parent.condition;
  new.sold_on := parent.sold_on;
  new.sold_price := parent.sold_price;
  new.payout_amount := parent.payout_amount;
  new.lot_seq := parent.lot_seq;
  new.deliverer_id := parent.deliverer_id;
  new.sku := app.accessory_sku_for_parent(parent.sku, old.sku);
  return new;
end;
$$;

drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create trigger items_redirect_accessory_shared_edits
  before update of status,packed_on,shipped_on,sales_channel,condition,sold_on,sold_price,payout_amount,sku,lot_seq,deliverer_id
  on app.items for each row execute function app.redirect_accessory_shared_edits();

drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
  after update of status,packed_on,shipped_on,sales_channel,condition,sold_on,sold_price,payout_amount,sku,lot_seq,deliverer_id
  on app.items for each row execute function app.sync_accessory_sale_date();

create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel, sold_price bigint, payout_amount bigint)
language plpgsql stable security definer set search_path=''
as $$
declare target app.items%rowtype;
declare source app.items%rowtype;
begin
  target := app.assert_can_work_on(p_item_id);
  if target.is_accessory and not app.is_standalone_accessory_serial(target.sku,target.lot_seq) then
    select parent.* into source from app.items parent
    where not parent.is_accessory and (
      parent.id = target.parent_item_id
      or (target.parent_item_id is null
          and parent.lot_seq = target.lot_seq
          and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq))
    )
    limit 1;
    if source.id is not null then
      return query select source.sales_channel,source.sold_price,source.payout_amount;
      return;
    end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;

create or replace function app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
returns jsonb
language plpgsql set search_path=''
as $$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
  v_parent_id uuid;
  v_parent_count integer;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text,179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) then
    select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
      from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq
        and app.product_serial(p.sku,p.lot_seq)=app.product_serial(v_input.sku,v_input.lot_seq);
    if v_parent_count=0 then
      select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
        from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq;
    end if;
    if v_parent_count<>1 then
      raise exception 'この通番号の本体を一意に特定できません。本体を先に登録してください' using errcode='22023';
    end if;
    v_input.parent_item_id := v_parent_id;
  end if;
  insert into app.items (parent_item_id,sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id)
  values (v_input.parent_item_id,v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'作業中'::app.item_status),v_input.memo,v_input.source_purchase_draft_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (parent_item_id,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,product_id,sales_channel,memo)
    values (v_item.id,v_item.lot_seq,true,coalesce(v_spare.owner_staff_id,v_item.purchaser_id),v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
        then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end,
      v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.product_id,v_item.sales_channel,v_spare.usage_note)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$$;



notify pgrst, 'reload schema';


-- ▼▼▼ 20261009113200_invoice_standalone_accessories.sql ▼▼▼

create or replace function app.guard_single_product_sale()
returns trigger language plpgsql set search_path=''
as 'declare serial_key text;
begin
  if tg_op=''UPDATE'' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null then return new; end if;
  if new.is_accessory and app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new; end if;
  if new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0 then return new; end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and not app.is_standalone_accessory_serial(i.sku,i.lot_seq)
      and i.amazon_returned_on is null and i.returned_on is null
      and i.marketplace is distinct from ''Amazon返品'' and i.status<>''返品処理''
  ) then
    raise exception ''同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。'';
  end if;
  return new;
end;';


-- C suffix accessories are standalone sales: include one invoice line at half the normal unit price.
create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as 'declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception ''請求書へのアクセス権がありません'' using errcode=''42501'';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception ''対象月が不正です''; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception ''請求単価の設定を管理者に確認してください''; end if;
 with invoice_items as (
   (select distinct on (lot_seq) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,p.unit_price as unit_price
   from app.items
   where deliverer_id=p_staff and not is_accessory and packed_on is not null
   order by lot_seq,packed_on,id)
   union all
   select id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,floor(p.unit_price/2.0)::bigint
   from app.items
   where deliverer_id=p_staff and is_accessory
     and app.is_standalone_accessory_serial(sku,lot_seq)
     and packed_on is not null
 ), selected as (
   select * from invoice_items
   where packed_on>=p_month and packed_on<p_month+interval ''1 month''
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   ''item_id'',id,''lot_seq'',lot_seq,''date'',purchased_at,''packed_on'',packed_on,
   ''description'',case
     when app.is_standalone_accessory_serial((select sku from app.items where id=invoice_items.id),lot_seq)
       then ''付属品単体販売''
     when marketplace::text=''Amazon返品'' then ''Amazon返品対応''
     when work_stream::text=''テレビ'' then ''モニター・テレビ''
     when work_stream::text=''ブルーレイ'' then ''ブルーレイレコーダー'' else ''小物'' end,
   ''title'',title,''quantity'',1,''unit_price'',unit_price,''amount'',unit_price
 ) order by purchased_at nulls last,lot_seq,id),''[]''::jsonb),
 count(*)*p.unit_price into lines,subtotal from selected;
 select coalesce(sum((value->>''amount'')::bigint),0) into subtotal from jsonb_array_elements(lines);
 return jsonb_build_object(''profile'',p.details,''lines'',lines,''subtotal'',subtotal,''tax_percent'',p.tax_percent);
end';
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

notify pgrst, 'reload schema';



-- ▼▼▼ 20261009113300_preserve_return_date_sync.sql ▼▼▼

create or replace function app.sync_accessory_sale_date()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  accessory app.items%rowtype;
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  for accessory in
    select a.* from app.items a
    where a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and (
      a.parent_item_id = new.id
      or (a.parent_item_id is null and a.lot_seq = old.lot_seq
          and app.product_serial(a.sku,a.lot_seq) = app.product_serial(old.sku,old.lot_seq))
    )
    for update
  loop
    update app.items set
      parent_item_id = new.id,
      status = new.status,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      returned_on = new.returned_on,
      sales_channel = new.sales_channel,
      condition = new.condition,
      sold_on = new.sold_on,
      sold_price = new.sold_price,
      payout_amount = new.payout_amount,
      sku = app.accessory_sku_for_parent(new.sku, accessory.sku),
      lot_seq = new.lot_seq,
      deliverer_id = new.deliverer_id
    where id = accessory.id;
  end loop;
  return new;
end;
$$;

create or replace function app.redirect_accessory_shared_edits()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory
     or app.is_standalone_accessory_serial(old.sku,old.lot_seq) then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  select p.* into parent from app.items p
  where not p.is_accessory and (
    p.id = coalesce(new.parent_item_id, old.parent_item_id)
    or (new.parent_item_id is null and old.parent_item_id is null
        and p.lot_seq = old.lot_seq
        and app.product_serial(p.sku,p.lot_seq) = app.product_serial(old.sku,old.lot_seq))
  )
  order by (p.id = coalesce(new.parent_item_id, old.parent_item_id)) desc
  limit 1
  for update;

  if parent.id is null then
    raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください' using errcode='22023';
  end if;

  update app.items set
    status = new.status,
    packed_on = new.packed_on,
    shipped_on = new.shipped_on,
    returned_on = new.returned_on,
    sales_channel = new.sales_channel,
    condition = new.condition,
    sold_on = new.sold_on,
    sold_price = new.sold_price,
    payout_amount = new.payout_amount,
    lot_seq = new.lot_seq,
    deliverer_id = new.deliverer_id,
    sku = parent.sku
  where id = parent.id;

  select * into parent from app.items where id = parent.id;
  new.parent_item_id := parent.id;
  new.status := parent.status;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.returned_on := parent.returned_on;
  new.sales_channel := parent.sales_channel;
  new.condition := parent.condition;
  new.sold_on := parent.sold_on;
  new.sold_price := parent.sold_price;
  new.payout_amount := parent.payout_amount;
  new.lot_seq := parent.lot_seq;
  new.deliverer_id := parent.deliverer_id;
  new.sku := app.accessory_sku_for_parent(parent.sku, old.sku);
  return new;
end;
$$;

drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create trigger items_redirect_accessory_shared_edits
  before update of status,packed_on,shipped_on,returned_on,sales_channel,condition,sold_on,sold_price,payout_amount,sku,lot_seq,deliverer_id
  on app.items for each row execute function app.redirect_accessory_shared_edits();

drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
  after update of status,packed_on,shipped_on,sales_channel,condition,sold_on,sold_price,payout_amount,sku,lot_seq,deliverer_id
  on app.items for each row execute function app.sync_accessory_sale_date();

create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel, sold_price bigint, payout_amount bigint)
language plpgsql stable security definer set search_path=''
as $$
declare target app.items%rowtype;
declare source app.items%rowtype;
begin
  target := app.assert_can_work_on(p_item_id);
  if target.is_accessory and not app.is_standalone_accessory_serial(target.sku,target.lot_seq) then
    select parent.* into source from app.items parent
    where not parent.is_accessory and (
      parent.id = target.parent_item_id
      or (target.parent_item_id is null
          and parent.lot_seq = target.lot_seq
          and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq))
    )
    limit 1;
    if source.id is not null then
      return query select source.sales_channel,source.sold_price,source.payout_amount;
      return;
    end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;

create or replace function app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
returns jsonb
language plpgsql set search_path=''
as $$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
  v_parent_id uuid;
  v_parent_count integer;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text,179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) then
    select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
      from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq
        and app.product_serial(p.sku,p.lot_seq)=app.product_serial(v_input.sku,v_input.lot_seq);
    if v_parent_count=0 then
      select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
        from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq;
    end if;
    if v_parent_count<>1 then
      raise exception 'この通番号の本体を一意に特定できません。本体を先に登録してください' using errcode='22023';
    end if;
    v_input.parent_item_id := v_parent_id;
  end if;
  insert into app.items (parent_item_id,sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id)
  values (v_input.parent_item_id,v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'作業中'::app.item_status),v_input.memo,v_input.source_purchase_draft_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (parent_item_id,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,product_id,sales_channel,memo)
    values (v_item.id,v_item.lot_seq,true,coalesce(v_spare.owner_staff_id,v_item.purchaser_id),v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
        then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end,
      v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.product_id,v_item.sales_channel,v_spare.usage_note)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$$;



notify pgrst, 'reload schema';


-- ▼▼▼ 20261011090000_preserve_explicit_listing_status.sql ▼▼▼

create or replace function app.items_sync_status()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'app'
as $function$
begin
  if tg_op = 'UPDATE'
     and new.status = '出品中'
     and new.status is distinct from old.status
     and new.shipped_on is not distinct from old.shipped_on then
    return new;
  end if;
  if new.status in ('返品処理', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$function$;


-- ▼▼▼ 20261011150000_force_amazon_return_cost_zero.sql ▼▼▼

create or replace function app.items_sync_status()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'app'
as $function$
begin
  if new.marketplace in ('Amazon返品', '動作品Amazon返品') then
    new.cost_amount := 0;
  end if;
  if tg_op = 'UPDATE'
     and new.status = '出品中'
     and new.status is distinct from old.status
     and new.shipped_on is not distinct from old.shipped_on then
    return new;
  end if;
  if new.status in ('返品処理', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$function$;

-- ▼▼▼ 20261013100000_delivery_return_request_tasks.sql ▼▼▼

-- Amazon返品が作業中になった商品に、返送依頼作成タスクを作る。
create table if not exists app.delivery_return_request_tasks (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references app.staff(id) on delete set null
);

create index if not exists delivery_return_request_open_idx
  on app.delivery_return_request_tasks(created_at desc)
  where completed_at is null;

alter table app.delivery_return_request_tasks enable row level security;
revoke all on app.delivery_return_request_tasks from public, anon, authenticated;
grant select on app.delivery_return_request_tasks to authenticated;

drop policy if exists delivery_return_request_select on app.delivery_return_request_tasks;
create policy delivery_return_request_select on app.delivery_return_request_tasks
  for select to authenticated using (
    exists (
      select 1 from app.items i
      where i.id = item_id
        and (app.is_admin() or app.current_role() = 'purchaser' or i.deliverer_id = app.current_staff_id())
    )
  );

create or replace function app.create_delivery_return_request_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.marketplace = 'Amazon返品'::app.marketplace
     and new.status = '作業中'::app.item_status
     and (tg_op = 'INSERT' or old.marketplace is distinct from new.marketplace or old.status is distinct from new.status)
     and not exists (
       select 1 from app.delivery_return_request_tasks t
       where t.item_id = new.id and t.completed_at is null
     ) then
    insert into app.delivery_return_request_tasks(item_id) values (new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists items_create_delivery_return_request_task on app.items;
create trigger items_create_delivery_return_request_task
  after insert or update of marketplace, status on app.items
  for each row execute function app.create_delivery_return_request_task();

insert into app.delivery_return_request_tasks(item_id)
select i.id
from app.items i
where i.marketplace = 'Amazon返品'::app.marketplace
  and i.status = '作業中'::app.item_status
  and not exists (
    select 1 from app.delivery_return_request_tasks t
    where t.item_id = i.id and t.completed_at is null
  );

create or replace view app.v_delivery_return_request_tasks with (security_invoker = true) as
select t.id, t.item_id, i.sku, i.lot_seq, i.title, p.model_no, i.asin,
       i.deliverer_id, t.created_at, t.completed_at
from app.delivery_return_request_tasks t
join app.items i on i.id = t.item_id
left join app.products p on p.id = i.product_id
where t.completed_at is null
  and i.marketplace = 'Amazon返品'::app.marketplace
  and i.status = '作業中'::app.item_status;

revoke all on app.v_delivery_return_request_tasks from public, anon;
grant select on app.v_delivery_return_request_tasks to authenticated;

create or replace function app.complete_delivery_return_request_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item app.items;
begin
  if auth.uid() is null then raise exception '認証が必要です' using errcode = '42501'; end if;
  select i.* into v_item
  from app.delivery_return_request_tasks t join app.items i on i.id = t.item_id
  where t.id = p_task_id and t.completed_at is null for update;
  if not found then raise exception '対象の返送依頼作成タスクが見つかりません' using errcode = 'P0002'; end if;
  if not (app.is_admin() or app.current_role() = 'purchaser' or v_item.deliverer_id = app.current_staff_id()) then
    raise exception 'タスク完了の権限がありません' using errcode = '42501';
  end if;
  update app.delivery_return_request_tasks
    set completed_at = clock_timestamp(), completed_by = app.current_staff_id()
    where id = p_task_id and completed_at is null;
end;
$$;
revoke all on function app.complete_delivery_return_request_task(uuid) from public, anon;
grant execute on function app.complete_delivery_return_request_task(uuid) to authenticated;
notify pgrst, 'reload schema';


-- ▼▼▼ 20261014042605_product_family_accounting.sql ▼▼▼

-- Finance-only lineage; existing SKU, search and routing retain their exact serial.
create or replace function app.financial_product_serial(p_sku text,p_lot_seq integer)
returns text language sql immutable security invoker set search_path='' as $$
 select regexp_replace(lower(app.product_serial(p_sku,p_lot_seq)), '^([0-9]+)[ab]+$', '\1');
$$;
create index if not exists items_financial_family_idx on app.items (app.financial_product_serial(sku,lot_seq));
create or replace view app.v_financial_members with (security_invoker=true) as
select i.id,i.sku,i.lot_seq,i.is_accessory,i.parent_item_id,i.title,i.marketplace,
 i.purchased_at,i.created_at,i.status,i.sold_on,i.sold_price,i.payout_amount,
 i.cost_amount,i.refund_amount,i.inventory_refund_amount,i.shipping_cost,i.other_cost,
 lower(app.product_serial(i.sku,i.lot_seq)) as serial_key,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key,
 (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq)) as is_sale_item
from app.items i;
create or replace view app.v_financial_families with (security_invoker=true) as
with bodies as (
 select distinct on (family_key) family_key,id as origin_item_id,cost_amount as body_cost,purchased_at as origin_purchased_at
 from app.v_financial_members where is_sale_item
 order by family_key,(serial_key=family_key) desc,purchased_at nulls last,created_at,id
), accessories as (
 select family_key,sum(cost_amount)::bigint as accessory_cost
 from app.v_financial_members where not is_sale_item group by family_key
)
select b.family_key,b.origin_item_id,b.origin_purchased_at,
 (b.body_cost+coalesce(a.accessory_cost,0))::bigint as family_cost
from bodies b left join accessories a using(family_key);

-- A zero-value closure with a successor is history; genuine standalone zero-price sales remain sales.
create or replace view app.v_financial_sale_sources with (security_invoker=true) as
select m.* from app.v_financial_members m
where m.is_sale_item and m.sold_on is not null
 and not (m.sold_price is not distinct from 0 and m.payout_amount is not distinct from 0
 and m.refund_amount=0 and m.inventory_refund_amount=0 and m.shipping_cost=0 and m.other_cost=0 and exists (
  select 1 from app.v_financial_members successor
  where successor.is_sale_item and successor.family_key=m.family_key and successor.serial_key<>m.serial_key
   and (m.serial_key=m.family_key or
     (coalesce(successor.purchased_at,successor.created_at::date),successor.created_at,successor.id)>
     (coalesce(m.purchased_at,m.created_at::date),m.created_at,m.id))
 ));
-- Count each actual sale stage; synchronized accessory amounts are not a second sale.
-- Charge the original body and accessory cost once, at the first genuine sale.
create or replace view app.v_financial_sales with (security_invoker=true) as
with events as (
 select s.*,row_number() over(partition by family_key order by sold_on,purchased_at nulls last,created_at,id) as family_sale_order
 from app.v_financial_sale_sources s
), costs as (
 select e.id,coalesce(sum(a.refund_amount+a.inventory_refund_amount),0)::bigint as accessory_refunds,
 coalesce(sum(a.shipping_cost),0)::bigint as accessory_shipping,
 coalesce(sum(a.other_cost),0)::bigint as accessory_other
 from events e left join app.v_financial_members a on not a.is_sale_item
  and a.serial_key=e.serial_key and (a.parent_item_id is null or a.parent_item_id=e.id)
 group by e.id
)
select e.id,e.lot_seq,e.sku,e.is_accessory,e.title,e.marketplace,
 f.origin_purchased_at as purchased_at,e.sold_on,
 case when e.family_sale_order=1 then f.family_cost else 0::bigint end as cost_amount,
 e.sold_price,e.payout_amount,
 (e.refund_amount+e.inventory_refund_amount+c.accessory_refunds)::bigint as refund_amount,
 (e.shipping_cost+c.accessory_shipping)::bigint as shipping_cost,
 (e.other_cost+c.accessory_other)::bigint as other_cost,
 (coalesce(e.payout_amount,0)+e.refund_amount+e.inventory_refund_amount+c.accessory_refunds
  -case when e.family_sale_order=1 then f.family_cost else 0 end
  -e.shipping_cost-c.accessory_shipping-e.other_cost-c.accessory_other)::bigint as profit,
 e.family_key,e.serial_key,f.family_cost,f.origin_item_id
from events e join app.v_financial_families f using(family_key) join costs c on c.id=e.id;
revoke all on app.v_financial_members,app.v_financial_families,app.v_financial_sale_sources,app.v_financial_sales from anon;
grant select on app.v_financial_members,app.v_financial_families,app.v_financial_sale_sources,app.v_financial_sales to authenticated,service_role;
create or replace view app.v_monthly_summary as
 WITH purchased AS (
         SELECT date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date AS month,
            count(*) AS "仕入数",
            sum(items.cost_amount) AS "仕入金額",
            avg(items.cost_amount)::bigint AS "平均仕入額"
           FROM app.items
          GROUP BY (date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date)
        ), sold AS (
         SELECT date_trunc('month'::text, items.sold_on::timestamp with time zone)::date AS month,
            count(DISTINCT items.family_key) AS "販売数",
            sum(items.sold_price) AS "売上",
            sum(items.payout_amount) AS "振込金額",
            sum(items.profit) AS "粗利益",
            avg(items.sold_price)::bigint AS "平均販売額",
            avg(items.sold_on - items.purchased_at)::numeric(10,1) AS "平均回転日数"
           FROM app.v_financial_sales items
          WHERE items.sold_on IS NOT NULL
          GROUP BY (date_trunc('month'::text, items.sold_on::timestamp with time zone)::date)
        ), expense AS (
         SELECT date_trunc('month'::text, expenses.incurred_on::timestamp with time zone)::date AS month,
            sum(expenses.amount) AS "経費"
           FROM app.expenses
          GROUP BY (date_trunc('month'::text, expenses.incurred_on::timestamp with time zone)::date)
        )
 SELECT COALESCE(p.month, s.month, e.month) AS month,
    COALESCE(p."仕入数", 0::bigint) AS "仕入数",
    COALESCE(p."仕入金額", 0::numeric) AS "仕入金額",
    COALESCE(p."平均仕入額", 0::bigint) AS "平均仕入額",
    COALESCE(s."販売数", 0::bigint) AS "販売数",
    COALESCE(s."売上", 0::numeric) AS "売上",
    COALESCE(s."振込金額", 0::numeric) AS "振込金額",
    COALESCE(s."粗利益", 0::numeric) AS "粗利益",
    COALESCE(s."平均販売額", 0::bigint) AS "平均販売額",
    s."平均回転日数",
    COALESCE(e."経費", 0::numeric) AS "経費",
    COALESCE(s."粗利益", 0::numeric) - COALESCE(e."経費", 0::numeric) AS "純利益"
   FROM purchased p
     FULL JOIN sold s ON s.month = p.month
     FULL JOIN expense e ON e.month = COALESCE(p.month, s.month)
  ORDER BY (COALESCE(p.month, s.month, e.month)) DESC;

create or replace view app.v_inventory_display as
 WITH financial_totals AS MATERIALIZED (select family_key,sum(profit)::numeric as profit from app.v_financial_sales group by family_key), totals AS MATERIALIZED (
         SELECT app.product_serial(i.sku, i.lot_seq) AS serial_key,
            sum(i.refund_amount) AS refunds,
            sum(i.inventory_refund_amount) AS inventory_refunds,
            sum(i.shipping_cost) AS shipping,
            sum(i.other_cost) AS other_cost
           FROM app.items i
          GROUP BY (app.product_serial(i.sku, i.lot_seq))
        )
 SELECT inventory.id,
    inventory.sku,
    inventory.lot_seq,
    inventory.is_accessory,
    inventory.status,
    inventory.condition,
    inventory.title,
    inventory.asin,
    inventory.model_no,
    inventory.maker,
    inventory.genre,
    inventory.turnover,
    inventory.purchased_at,
    inventory.cost_amount,
    inventory.marketplace,
    inventory.marketplace_url,
    inventory.card_name,
    inventory.purchaser_name,
    inventory.deliverer_name,
    inventory.work_stream,
    inventory.deliverer_id,
    inventory.purchaser_id,
    inventory.tracking_no,
    inventory.planned_price,
    inventory.planned_payout,
    inventory.sales_channel,
    inventory.product_registered,
    inventory.inspected,
    inventory.photo_uploaded,
    inventory.packed_on,
    inventory.shipped_on,
    inventory.listed_on,
    inventory.sold_on,
    inventory.sold_price,
    inventory.payout_amount,
    inventory.amazon_returned_on,
    inventory.refund_amount,
    inventory.profit,
    inventory.days_to_sell,
    inventory.days_in_stock,
    (inventory.planned_payout+coalesce(financial_totals.profit,-family.family_cost,-inventory.product_cost))::bigint AS expected_profit,
    inventory.accessories,
    inventory.memo,
    inventory.updated_at,
    inventory.product_row_count,
    coalesce(family.family_cost,inventory.product_cost)::bigint AS product_cost,
    inventory.sale_row_count,
    inventory.product_sale_conflict,
    inventory.product_sold_on,
    inventory.product_sold_price,
    inventory.product_payout_amount,
    raw.product_id,
    product.product_no,
    COALESCE(NULLIF(btrim(product.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS amazon_image_url,
    raw.amazon_refund_amount,
    raw.non_amazon_refund_amount,
    latest.body AS latest_comment,
        CASE WHEN NOT inventory.product_sale_conflict AND inventory.product_sold_on IS NOT NULL
          THEN financial_totals.profit
          ELSE NULL::numeric END AS product_profit,
    raw.inventory_refund_amount
   FROM app.v_inventory_items inventory
     JOIN app.items raw ON raw.id = inventory.id
     LEFT JOIN app.v_financial_families family ON family.family_key=app.financial_product_serial(raw.sku,raw.lot_seq)
     LEFT JOIN financial_totals ON financial_totals.family_key=family.family_key
     LEFT JOIN app.products product ON product.id = raw.product_id
     LEFT JOIN app.products asin_product ON asin_product.asin = raw.asin
     LEFT JOIN totals ON totals.serial_key = app.product_serial(raw.sku, raw.lot_seq)
     LEFT JOIN LATERAL ( SELECT item_comments.body
           FROM app.item_comments
          WHERE item_comments.item_id = inventory.id
          ORDER BY item_comments.created_at DESC, item_comments.id DESC
         LIMIT 1) latest ON true;

create or replace view app.v_stock_summary as
with current_items as (
 select distinct on (app.financial_product_serial(i.sku,i.lot_seq)) i.*,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key
 from app.items i where not i.is_accessory and i.status not in ('販売済','返品処理') and i.sold_on is null
 order by app.financial_product_serial(i.sku,i.lot_seq),i.purchased_at desc nulls last,i.created_at desc,i.id
)
select count(*) as "現在庫数",coalesce(sum(f.family_cost),0)::numeric as "仕入金額合計",
 coalesce(sum(coalesce(i.planned_payout,0)),0)::numeric as "売上見込み合計",
 coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,-f.family_cost)),0)::numeric as "見込み利益合計",
 count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
 count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
 count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
 count(*) filter(where i.status='作業中') as "作業中",
 count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using(family_key)
left join (select family_key,sum(profit) as profit from app.v_financial_sales group by family_key) realized using(family_key);
notify pgrst,'reload schema';


-- Use the same sale events and original purchaser in staff profit reports.
create or replace function app.monthly_gross_profit_by_purchaser(p_purchaser_id uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare current_id uuid:=app.current_staff_id(); current_user_role text:=app.current_role(); result jsonb;
begin
 if auth.uid() is null or current_id is null or p_month is null or extract(day from p_month)<>1 then
  raise exception '対象月またはログイン情報が不正です' using errcode='22023';
 end if;
 if current_user_role='admin' then
  if p_purchaser_id is null or not exists(select 1 from app.staff where id=p_purchaser_id and is_active and role in ('admin','purchaser')) then
   raise exception '仕入担当者を選択してください' using errcode='22023';
  end if;
 elsif current_user_role='purchaser' then
  if p_purchaser_id is distinct from current_id then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 elsif current_user_role='deliverer' then
  if p_purchaser_id is not null then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 else raise exception '閲覧する権限がありません' using errcode='42501'; end if;

 with products as (
  select s.serial_key,s.sku,s.sold_on,owner.name as purchaser_name,s.profit as gross_profit
  from app.v_financial_sales s
  join app.items event_item on event_item.id=s.id
  join app.items origin on origin.id=s.origin_item_id
  left join app.staff owner on owner.id=origin.purchaser_id
  where s.sold_on>=p_month and s.sold_on<p_month+interval '1 month'
    and ((current_user_role='admin' and origin.purchaser_id=p_purchaser_id)
      or (current_user_role='purchaser' and origin.purchaser_id=current_id)
      or (current_user_role='deliverer' and event_item.deliverer_id=current_id))
 )
 select jsonb_build_object(
  'rows',coalesce(jsonb_agg(jsonb_build_object('sku',sku,'sold_on',sold_on,'purchaser_name',purchaser_name,'gross_profit',gross_profit) order by sold_on,sku),'[]'::jsonb),
  'total',coalesce(sum(gross_profit),0)
 ) into result from products;
 return result;
end $$;
revoke all on function app.monthly_gross_profit_by_purchaser(uuid,date) from public,anon,authenticated;
grant execute on function app.monthly_gross_profit_by_purchaser(uuid,date) to authenticated;


-- ▼▼▼ 20261014060000_final_sale_cost_and_serial_invoices.sql ▼▼▼

create or replace view app.v_financial_sale_sources with (security_invoker=true) as
with members as materialized (select * from app.v_financial_members)
select m.* from members m
where m.is_sale_item and m.sold_on is not null
 and not (m.sold_price is not distinct from 0 and m.payout_amount is not distinct from 0
 and m.refund_amount=0 and m.inventory_refund_amount=0 and m.shipping_cost=0 and m.other_cost=0 and exists (
  select 1 from members successor
  where successor.is_sale_item and successor.family_key=m.family_key and successor.serial_key<>m.serial_key
   and (m.serial_key=m.family_key or
     (coalesce(successor.purchased_at,successor.created_at::date),successor.created_at,successor.id)>
     (coalesce(m.purchased_at,m.created_at::date),m.created_at,m.id))
 ));

-- Defer the family cost while the latest return stage is unsold.
-- Allocate once to the latest genuine sale after the current stage sells.
create or replace view app.v_financial_sales with (security_invoker=true) as
with latest_stages as (
 select distinct on (m.family_key) m.family_key,m.serial_key,m.sold_on,m.status,
  i.returned_on,i.amazon_returned_on
 from app.v_financial_members m join app.items i on i.id=m.id where m.is_sale_item
 order by m.family_key,m.created_at desc,length(m.serial_key) desc,m.purchased_at desc nulls last,m.id
), events as (
 select s.*,row_number() over(partition by family_key order by sold_on desc,created_at desc,length(serial_key) desc,purchased_at desc nulls last,id desc) as family_sale_order
 from app.v_financial_sale_sources s
), costs as (
 select e.id,coalesce(sum(a.refund_amount+a.inventory_refund_amount),0)::bigint as accessory_refunds,
 coalesce(sum(a.shipping_cost),0)::bigint as accessory_shipping,
 coalesce(sum(a.other_cost),0)::bigint as accessory_other
 from events e left join app.v_financial_members a on not a.is_sale_item
  and a.serial_key=e.serial_key and (a.parent_item_id is null or a.parent_item_id=e.id)
 group by e.id
)
select e.id,e.lot_seq,e.sku,e.is_accessory,e.title,e.marketplace,
 f.origin_purchased_at as purchased_at,e.sold_on,
 case when e.family_sale_order=1 and terminal.serial_key=e.serial_key and terminal.sold_on is not null and terminal.status<>'返品処理' and (terminal.returned_on is null or terminal.returned_on<=e.sold_on) and (terminal.amazon_returned_on is null or terminal.amazon_returned_on<=e.sold_on) then f.family_cost else 0::bigint end as cost_amount,
 e.sold_price,e.payout_amount,
 (e.refund_amount+e.inventory_refund_amount+c.accessory_refunds)::bigint as refund_amount,
 (e.shipping_cost+c.accessory_shipping)::bigint as shipping_cost,
 (e.other_cost+c.accessory_other)::bigint as other_cost,
 (coalesce(e.payout_amount,0)+e.refund_amount+e.inventory_refund_amount+c.accessory_refunds
  -case when e.family_sale_order=1 and terminal.serial_key=e.serial_key and terminal.sold_on is not null and terminal.status<>'返品処理' and (terminal.returned_on is null or terminal.returned_on<=e.sold_on) and (terminal.amazon_returned_on is null or terminal.amazon_returned_on<=e.sold_on) then f.family_cost else 0 end
  -e.shipping_cost-c.accessory_shipping-e.other_cost-c.accessory_other)::bigint as profit,
 e.family_key,e.serial_key,f.family_cost,f.origin_item_id
from events e join app.v_financial_families f using(family_key) join costs c on c.id=e.id join latest_stages terminal using(family_key);

create or replace view app.v_inventory_display as
 WITH financial_totals AS MATERIALIZED (select family_key,sum(profit)::numeric as profit,sum(cost_amount)::numeric as allocated_cost from app.v_financial_sales group by family_key)
 SELECT inventory.id,
    inventory.sku,
    inventory.lot_seq,
    inventory.is_accessory,
    inventory.status,
    inventory.condition,
    inventory.title,
    inventory.asin,
    inventory.model_no,
    inventory.maker,
    inventory.genre,
    inventory.turnover,
    inventory.purchased_at,
    inventory.cost_amount,
    inventory.marketplace,
    inventory.marketplace_url,
    inventory.card_name,
    inventory.purchaser_name,
    inventory.deliverer_name,
    inventory.work_stream,
    inventory.deliverer_id,
    inventory.purchaser_id,
    inventory.tracking_no,
    inventory.planned_price,
    inventory.planned_payout,
    inventory.sales_channel,
    inventory.product_registered,
    inventory.inspected,
    inventory.photo_uploaded,
    inventory.packed_on,
    inventory.shipped_on,
    inventory.listed_on,
    inventory.sold_on,
    inventory.sold_price,
    inventory.payout_amount,
    inventory.amazon_returned_on,
    inventory.refund_amount,
    inventory.profit,
    inventory.days_to_sell,
    inventory.days_in_stock,
    (inventory.planned_payout+coalesce(financial_totals.profit,0)-coalesce(family.family_cost,inventory.product_cost)+coalesce(financial_totals.allocated_cost,0))::bigint AS expected_profit,
    inventory.accessories,
    inventory.memo,
    inventory.updated_at,
    inventory.product_row_count,
    coalesce(family.family_cost,inventory.product_cost)::bigint AS product_cost,
    inventory.sale_row_count,
    inventory.product_sale_conflict,
    inventory.product_sold_on,
    inventory.product_sold_price,
    inventory.product_payout_amount,
    raw.product_id,
    product.product_no,
    COALESCE(NULLIF(btrim(product.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS amazon_image_url,
    raw.amazon_refund_amount,
    raw.non_amazon_refund_amount,
    latest.body AS latest_comment,
        CASE WHEN NOT inventory.product_sale_conflict AND inventory.product_sold_on IS NOT NULL
          THEN financial_totals.profit
          ELSE NULL::numeric END AS product_profit,
    raw.inventory_refund_amount
   FROM app.v_inventory_items inventory
     JOIN app.items raw ON raw.id = inventory.id
     LEFT JOIN app.v_financial_families family ON family.family_key=app.financial_product_serial(raw.sku,raw.lot_seq)
     LEFT JOIN financial_totals ON financial_totals.family_key=family.family_key
     LEFT JOIN app.products product ON product.id = raw.product_id
     LEFT JOIN app.products asin_product ON asin_product.asin = raw.asin
     LEFT JOIN LATERAL ( SELECT item_comments.body
           FROM app.item_comments
          WHERE item_comments.item_id = inventory.id
          ORDER BY item_comments.created_at DESC, item_comments.id DESC
         LIMIT 1) latest ON true;

create or replace view app.v_stock_summary as
with current_items as (
 select distinct on (app.financial_product_serial(i.sku,i.lot_seq)) i.*,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key
 from app.items i where not i.is_accessory and i.status not in ('販売済','返品処理') and i.sold_on is null
 order by app.financial_product_serial(i.sku,i.lot_seq),i.purchased_at desc nulls last,i.created_at desc,i.id
)
select count(*) as "現在庫数",coalesce(sum(f.family_cost),0)::numeric as "仕入金額合計",
 coalesce(sum(coalesce(i.planned_payout,0)),0)::numeric as "売上見込み合計",
 coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,0)-f.family_cost+coalesce(realized.allocated_cost,0)),0)::numeric as "見込み利益合計",
 count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
 count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
 count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
 count(*) filter(where i.status='作業中') as "作業中",
 count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using(family_key)
left join (select family_key,sum(profit) as profit,sum(cost_amount) as allocated_cost from app.v_financial_sales group by family_key) realized using(family_key);

-- Charge each exact serial's completed work separately; C and B work is half price.
create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception '請求書へのアクセス権がありません' using errcode='42501';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 with invoice_items as (
  select distinct on(lower(app.product_serial(sku,lot_seq))) id,sku,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,
   app.product_serial(sku,lot_seq) as serial_key,
   app.is_standalone_accessory_serial(sku,lot_seq) as standalone,
   (lower(app.product_serial(sku,lot_seq)) ~ '^[0-9]+[ab]*b$' or marketplace::text='動作品Amazon返品') as half_return
  from app.items where deliverer_id=p_staff and packed_on is not null
    and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq))
  order by lower(app.product_serial(sku,lot_seq)),packed_on,id
 ), selected as (
  select *,case when standalone or half_return then floor(p.unit_price/2.0)::bigint else p.unit_price::bigint end as price
  from invoice_items where packed_on>=p_month and packed_on<p_month+interval '1 month'
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'item_id',id,'sku',sku,'serial',serial_key,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
  'description',case when standalone then '付属品単体販売' when half_return then '動作品Amazon返品対応'
   when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
   when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
  'title',title,'quantity',1,'unit_price',price,'amount',price
 ) order by purchased_at nulls last,lot_seq,serial_key,id),'[]'::jsonb),coalesce(sum(price),0)
 into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261014080000_inventory_single_read.sql ▼▼▼

-- Return the purchase reference with each inventory row; avoid a second full-table read.
create or replace view app.v_inventory_display as
 WITH financial_totals AS MATERIALIZED (select family_key,sum(profit)::numeric as profit,sum(cost_amount)::numeric as allocated_cost from app.v_financial_sales group by family_key)
 SELECT inventory.id,
    inventory.sku,
    inventory.lot_seq,
    inventory.is_accessory,
    inventory.status,
    inventory.condition,
    inventory.title,
    inventory.asin,
    inventory.model_no,
    inventory.maker,
    inventory.genre,
    inventory.turnover,
    inventory.purchased_at,
    inventory.cost_amount,
    inventory.marketplace,
    inventory.marketplace_url,
    inventory.card_name,
    inventory.purchaser_name,
    inventory.deliverer_name,
    inventory.work_stream,
    inventory.deliverer_id,
    inventory.purchaser_id,
    inventory.tracking_no,
    inventory.planned_price,
    inventory.planned_payout,
    inventory.sales_channel,
    inventory.product_registered,
    inventory.inspected,
    inventory.photo_uploaded,
    inventory.packed_on,
    inventory.shipped_on,
    inventory.listed_on,
    inventory.sold_on,
    inventory.sold_price,
    inventory.payout_amount,
    inventory.amazon_returned_on,
    inventory.refund_amount,
    inventory.profit,
    inventory.days_to_sell,
    inventory.days_in_stock,
    (inventory.planned_payout+coalesce(financial_totals.profit,0)-coalesce(family.family_cost,inventory.product_cost)+coalesce(financial_totals.allocated_cost,0))::bigint AS expected_profit,
    inventory.accessories,
    inventory.memo,
    inventory.updated_at,
    inventory.product_row_count,
    coalesce(family.family_cost,inventory.product_cost)::bigint AS product_cost,
    inventory.sale_row_count,
    inventory.product_sale_conflict,
    inventory.product_sold_on,
    inventory.product_sold_price,
    inventory.product_payout_amount,
    raw.product_id,
    product.product_no,
    COALESCE(NULLIF(btrim(product.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS amazon_image_url,
    raw.amazon_refund_amount,
    raw.non_amazon_refund_amount,
    latest.body AS latest_comment,
        CASE WHEN NOT inventory.product_sale_conflict AND inventory.product_sold_on IS NOT NULL
          THEN financial_totals.profit
          ELSE NULL::numeric END AS product_profit,
    raw.inventory_refund_amount,
    case when (select app.current_role()) in ('admin','purchaser')
      or raw.deliverer_id=(select app.current_staff_id())
      then raw.marketplace_item_id else null end as marketplace_item_id
   FROM app.v_inventory_items inventory
     JOIN app.items raw ON raw.id = inventory.id
     LEFT JOIN app.v_financial_families family ON family.family_key=app.financial_product_serial(raw.sku,raw.lot_seq)
     LEFT JOIN financial_totals ON financial_totals.family_key=family.family_key
     LEFT JOIN app.products product ON product.id = raw.product_id
     LEFT JOIN app.products asin_product ON asin_product.asin = raw.asin
     LEFT JOIN LATERAL ( SELECT item_comments.body
           FROM app.item_comments
          WHERE item_comments.item_id = inventory.id
          ORDER BY item_comments.created_at DESC, item_comments.id DESC
         LIMIT 1) latest ON true;

notify pgrst,'reload schema';


-- ▼▼▼ 20261014080100_spare_holder_and_manufacturer.sql ▼▼▼

-- Preserve full serial identity; store the physical delivery holder for generated spares.
create or replace function app.move_inventory_accessory_to_spares(
  p_item_id uuid,
  p_spare_input jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item app.items%rowtype;
  v_spare_id uuid;
  v_owner_id uuid;
  v_owner_name text;
  v_registered_serial text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備一覧へ登録する権限がありません' using errcode='42501';
  end if;
  if p_spare_input is null or jsonb_typeof(p_spare_input) <> 'object' then
    raise exception 'リモコン情報が不正です' using errcode='22023';
  end if;

  select * into v_item from app.items where id=p_item_id for update;
  if not found then raise exception '在庫一覧のリモコン行が見つかりません' using errcode='P0002'; end if;
  if not v_item.is_accessory or v_item.title not ilike '%リモコン%' then
    raise exception '対象は付属品登録されたリモコン行ではありません' using errcode='22023';
  end if;
  if app.current_role() = 'purchaser' and v_item.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外のリモコン行は移動できません' using errcode='42501';
  end if;
  if coalesce(p_spare_input->>'usage_note','') !~ '^[0-9]+[a-z]*$' then
    raise exception '利用記録に通番号を入力してください' using errcode='22023';
  end if;
  v_registered_serial := upper(p_spare_input->>'usage_note');
  if v_registered_serial is distinct from app.product_serial(v_item.sku,v_item.lot_seq) then
    raise exception '入力した通番号と在庫行の通番号が一致しません' using errcode='22023';
  end if;

  v_owner_id := coalesce(nullif(p_spare_input->>'owner_staff_id','')::uuid, v_item.deliverer_id, v_item.purchaser_id, app.current_staff_id());
  if app.current_role() = 'purchaser' and v_owner_id is distinct from app.current_staff_id() and v_owner_id is distinct from v_item.deliverer_id then
    raise exception '保管担当者には自分または商品の納品担当者を指定してください' using errcode='42501';
  end if;
  select name into v_owner_name from app.staff where id=v_owner_id;
  v_owner_name := coalesce(nullif(btrim(p_spare_input->>'owner_name'),''),v_owner_name);
  if nullif(btrim(p_spare_input->>'title'),'') is null then
    raise exception '品名を入力してください' using errcode='22023';
  end if;
  if coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount) < 0 then
    raise exception '仕入金額は0円以上で入力してください' using errcode='22023';
  end if;

  insert into app.spare_accessories (
    source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
    cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
  ) values (
    coalesce(nullif(p_spare_input->>'source_sku',''),v_item.sku),
    v_owner_id,v_owner_name,
    coalesce(nullif(p_spare_input->>'purchased_at','')::date,v_item.purchased_at),
    btrim(p_spare_input->>'title'),
    nullif(btrim(p_spare_input->>'manufacturer'),''),
    nullif(btrim(p_spare_input->>'model_no'),''),
    nullif(btrim(p_spare_input->>'asin'),''),
    coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount),
    nullif(p_spare_input->>'marketplace',''),
    nullif(p_spare_input->>'marketplace_item_id',''),
    nullif(p_spare_input->>'tracking_no',''),
    p_spare_input->>'usage_note'
  ) returning id into v_spare_id;

  delete from app.items where id=v_item.id;
  return v_spare_id;
end;
$$;

revoke all on function app.move_inventory_accessory_to_spares(uuid,jsonb) from public,anon;
grant execute on function app.move_inventory_accessory_to_spares(uuid,jsonb) to authenticated;

create or replace function app.prepare_yahoo_auction_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body app.items%rowtype;
  v_remote app.items%rowtype;
  v_remote_count integer;
  v_owner_id uuid;
  v_owner_name text;
  v_model_no text;
  v_maker text;
  v_serial text;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception 'ヤフオク販売の準備を行う権限がありません' using errcode='42501';
  end if;

  select * into v_body from app.items where id=p_item_id for update;
  if not found then raise exception '対象の在庫行が見つかりません' using errcode='P0002'; end if;
  if v_body.is_accessory then raise exception '本体の在庫行を選択してください' using errcode='22023'; end if;
  if app.current_role() = 'purchaser' and v_body.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外の商品はヤフオク販売に設定できません' using errcode='42501';
  end if;

  v_serial := lower(app.product_serial(v_body.sku,v_body.lot_seq));

  if exists (
    select 1 from app.spare_accessories s
    where lower(btrim(s.usage_note))=v_serial and s.title ilike '%リモコン%'
  ) then
  update app.items set sales_channel='ヤフオク'::app.sales_channel, updated_at=now() where id=v_body.id;
    return;
  end if;

  select count(*) into v_remote_count from app.items i
  where app.product_serial(i.sku,i.lot_seq)=app.product_serial(v_body.sku,v_body.lot_seq) and i.is_accessory and i.title ilike '%リモコン%';
  if v_remote_count > 1 then
    raise exception '通番号 % のリモコン行が複数あります。在庫一覧を確認してください。', v_serial using errcode='22023';
  end if;

  if v_remote_count = 1 then
    select * into v_remote from app.items i
    where app.product_serial(i.sku,i.lot_seq)=app.product_serial(v_body.sku,v_body.lot_seq) and i.is_accessory and i.title ilike '%リモコン%'
    limit 1 for update;
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_remote.product_id;
    v_owner_id := coalesce(v_body.deliverer_id,v_remote.deliverer_id,v_remote.purchaser_id,v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    perform app.move_inventory_accessory_to_spares(v_remote.id,jsonb_build_object(
      'source_sku',v_remote.sku,
      'owner_staff_id',v_owner_id,
      'owner_name',v_owner_name,
      'purchased_at',v_remote.purchased_at,
      'title',v_remote.title,
      'manufacturer',v_maker,
      'model_no',v_model_no,
      'asin',v_remote.asin,
      'cost_amount',v_remote.cost_amount,
      'marketplace',v_remote.marketplace,
      'marketplace_item_id',v_remote.marketplace_item_id,
      'tracking_no',v_remote.tracking_no,
      'usage_note',v_serial
    ));
  else
    select p.model_no,p.maker into v_model_no,v_maker from app.products p where p.id=v_body.product_id;
    v_owner_id := coalesce(v_body.deliverer_id,v_body.purchaser_id,app.current_staff_id());
    select s.name into v_owner_name from app.staff s where s.id=v_owner_id;
    insert into app.spare_accessories (
      source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
      cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note
    ) values (
      null,v_owner_id,v_owner_name,v_body.purchased_at,'リモコン',v_maker,v_model_no,v_body.asin,
      0,v_body.marketplace,v_body.marketplace_item_id,v_body.tracking_no,v_serial
    );
  end if;
  -- Move the remote before the body update synchronizes and replaces its SKU.
  update app.items set sales_channel='ヤフオク'::app.sales_channel, updated_at=now() where id=v_body.id;
end;
$$;

revoke all on function app.prepare_yahoo_auction_item(uuid) from public, anon;
grant execute on function app.prepare_yahoo_auction_item(uuid) to authenticated;

-- Keep explicit spare manufacturers; infer missing ones from the exact body serial.
create or replace function app.fill_spare_body_manufacturer() returns trigger
language plpgsql security invoker set search_path='' as $$
declare serial text; maker text;
begin
 if nullif(btrim(new.manufacturer),'') is not null then return new; end if;
 serial:=lower(btrim(regexp_replace(coalesce(new.usage_note,''),'リモコン','','g')));
 if serial !~ '^[0-9]+[a-z]*$' then return new; end if;
 select coalesce(nullif(btrim(p.maker),''),nullif(btrim(ap.maker),'')) into maker
 from app.items i left join app.products p on p.id=i.product_id
 left join app.products ap on ap.asin=i.asin
 where not i.is_accessory and lower(app.product_serial(i.sku,i.lot_seq))=serial
 order by i.created_at desc,i.id limit 1;
 if maker is not null then new.manufacturer:=maker; end if;
 return new;
end $$;
revoke all on function app.fill_spare_body_manufacturer() from public,anon,authenticated;
create trigger spare_body_manufacturer before insert or update of usage_note,manufacturer,source_sku
 on app.spare_accessories for each row execute function app.fill_spare_body_manufacturer();

-- Repair only the two usage records identified by the user, preserving source SKUs and purchase costs.
update app.spare_accessories s set manufacturer=coalesce(nullif(btrim(p.maker),''),nullif(btrim(ap.maker),'')),updated_at=now()
from app.items i left join app.products p on p.id=i.product_id left join app.products ap on ap.asin=i.asin
where not i.is_accessory and lower(app.product_serial(i.sku,i.lot_seq))=lower(btrim(s.usage_note))
 and lower(btrim(s.usage_note)) in ('2395','2398') and nullif(btrim(s.manufacturer),'') is null;
update app.spare_accessories s set owner_staff_id=i.deliverer_id,owner_name=staff.name,updated_at=now()
from app.items i join app.staff staff on staff.id=i.deliverer_id
where not i.is_accessory and lower(app.product_serial(i.sku,i.lot_seq))='2398'
 and lower(btrim(s.usage_note))='2398' and s.used_for_item_id is null
 and (s.owner_staff_id is distinct from i.deliverer_id or s.owner_name is distinct from staff.name);
notify pgrst,'reload schema';


-- ▼▼▼ 20261014100000_receipt_details_invoice_reimbursement.sql ▼▼▼

-- Receipt amounts are reimbursements including tax; they are added after invoice tax.
alter table app.invoice_receipts
 add column spent_on date,
 add column description text not null default '',
 add column amount bigint,
 add column payee text not null default '',
 add column memo text not null default '',
 add column include_in_invoice boolean not null default false,
 add column version integer not null default 1,
 add constraint invoice_receipt_detail_lengths check(length(description)<=200 and length(payee)<=200 and length(memo)<=2000),
 add constraint invoice_receipt_amount check(amount between 0 and 10000000),
 add constraint invoice_receipt_claim_complete check(not include_in_invoice or (document_type<>'invoice' and spent_on is not null and length(trim(description))>0 and amount is not null));
grant insert(spent_on,description,amount,payee,memo,include_in_invoice) on app.invoice_receipts to authenticated;
grant update(spent_on,description,amount,payee,memo,include_in_invoice) on app.invoice_receipts to authenticated;
create policy invoice_receipts_update on app.invoice_receipts for update to authenticated
 using(app.can_access_invoice_receipt(storage_path,true)) with check(app.can_access_invoice_receipt(storage_path,true));

create or replace function app.lock_invoice_receipt_changes() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare who uuid; target date; invoice uuid;
begin
 if tg_op='DELETE' then who:=old.staff_id; target:=old.billing_month; else who:=new.staff_id; target:=new.billing_month; end if;
 perform pg_advisory_xact_lock(hashtextextended(who::text||target::text,0));
 select id into invoice from app.delivery_invoices where staff_id=who and billing_month=target for update;
 if invoice is not null and exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice) then
  raise exception '承認済み請求書の領収書は変更できません';
 end if;
 if tg_op='UPDATE' and tg_table_name='invoice_receipts' then new.version:=old.version+1; end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger lock_invoice_receipt_changes on app.invoice_receipts;
create trigger lock_invoice_receipt_changes before insert or update or delete on app.invoice_receipts for each row execute function app.lock_invoice_receipt_changes();

create function app.invoice_receipt_lines(p_staff uuid,p_month date) returns jsonb
language sql stable security invoker set search_path=pg_catalog,app as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'date',spent_on,'spent_on',spent_on,'description',description,'quantity',1,'unit_price',amount,'amount',amount,
  'payee',payee,'memo',memo,'storage_path',storage_path,'original_name',original_name,'document_type',document_type,'mime_type',mime_type,
  'include_in_invoice',include_in_invoice,'version',version
 ) order by spent_on,created_at,id),'[]'::jsonb)
 from app.invoice_receipts where staff_id=p_staff and billing_month=p_month and include_in_invoice and document_type<>'invoice';
$$;
revoke all on function app.invoice_receipt_lines(uuid,date) from public,anon,authenticated;
grant execute on function app.invoice_receipt_lines(uuid,date) to authenticated;

create function app.fill_invoice_receipt_lines() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare lines jsonb; reimbursed bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.staff_id::text||new.billing_month::text,0));
 lines:=app.invoice_receipt_lines(new.staff_id,new.billing_month);
 select coalesce(sum((x->>'amount')::bigint),0) into reimbursed from jsonb_array_elements(lines) x;
 new.snapshot:=new.snapshot||jsonb_build_object('receipt_lines',lines,'receipt_subtotal',reimbursed);
 new.total:=new.total+reimbursed;
 return new;
end $$;
revoke all on function app.fill_invoice_receipt_lines() from public,anon,authenticated;
-- Runs after the existing calculation and approval lock triggers.
create trigger z_fill_invoice_receipt_lines before insert or update on app.delivery_invoices for each row execute function app.fill_invoice_receipt_lines();

create or replace function app.fill_receipt_submission() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'storage_path',storage_path,'original_name',original_name,'document_type',document_type,'mime_type',mime_type,
  'spent_on',spent_on,'description',description,'amount',amount,'payee',payee,'memo',memo,'include_in_invoice',include_in_invoice,'version',version
 ) order by created_at,id),'[]'::jsonb)
 into new.files from app.invoice_receipts where staff_id=new.staff_id and billing_month=new.billing_month and document_type in ('receipt','receipt_photo');
 if jsonb_array_length(new.files)=0 then raise exception '領収書または領収書の写真を追加してください'; end if;
 new.submitted_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;

create function app.check_invoice_receipts_on_approval() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices;
begin
 select * into inv from app.delivery_invoices where id=new.invoice_id for update;

 if coalesce(inv.snapshot->'receipt_lines','[]'::jsonb) is distinct from app.invoice_receipt_lines(inv.staff_id,inv.billing_month) then
  raise exception '領収書の明細が変更されています。請求書を再送信してから承認してください';
 end if;
 return new;
end $$;
revoke all on function app.check_invoice_receipts_on_approval() from public,anon,authenticated;
create trigger a_check_invoice_receipts before insert on app.delivery_invoice_approvals for each row execute function app.check_invoice_receipts_on_approval();
notify pgrst,'reload schema';

-- ▼▼▼ 20261015060311_restrict_management_reports.sql ▼▼▼

-- Management-only reports must also be protected at the Data API boundary.
-- Inventory and spares retain their existing RLS and editing rules.
create or replace function app.management_reports_allowed() returns boolean
language sql stable security invoker set search_path = ''
as $$ select coalesce(app.current_role() = 'admin', false) $$;
revoke all on function app.management_reports_allowed() from public,anon;
grant execute on function app.management_reports_allowed() to authenticated;
do $$
declare report_name text; definition text;
begin
  foreach report_name in array array['v_monthly_summary','v_stock_summary','v_deliverer_workload','v_antique_ledger','v_ledger_gaps','v_product_performance'] loop
    definition := pg_get_viewdef(format('app.%I',report_name)::regclass,true);
    if position('management_reports_allowed' in definition) = 0 then
      execute format('create or replace view app.%I with (security_invoker=true,security_barrier=true) as select report.* from (%s) report where (select app.management_reports_allowed())',report_name,rtrim(btrim(definition),';'));
    end if;
  end loop;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261015140356_preserve_dated_sale_status.sql ▼▼▼

-- A listing completion must not reopen an item with an actual sale date.
-- Keep supplier returns and all unsold workflow behavior unchanged.
create or replace function app.items_sync_status()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'app'
as $function$
begin
  if new.marketplace in ('Amazon返品', '動作品Amazon返品') then
    new.cost_amount := 0;
  end if;
  if new.sold_on is not null and new.status <> '返品処理' then
    new.status := '販売済';
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.status = '出品中'
     and new.status is distinct from old.status
     and new.shipped_on is not distinct from old.shipped_on then
    return new;
  end if;
  if new.status in ('返品処理', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$function$;


-- ▼▼▼ 20261015150924_ten_state_enum.sql ▼▼▼

alter type app.item_status rename value '作業中' to '受取前';
alter type app.item_status add value if not exists '検品中' before '出品中';
alter type app.item_status add value if not exists 'Amazon返送依頼' before '出品中';
alter type app.item_status add value if not exists 'Amazon補填申請中' before '出品中';
alter type app.item_status add value if not exists '商品登録前' before '出品中';
alter type app.item_status add value if not exists '取引中' after '出品中';
alter type app.item_status add value if not exists '動作不良' after '返品処理';


-- ▼▼▼ 20261015150926_ten_state_workflow.sql ▼▼▼

-- Replace legacy literals in stored PL/pgSQL bodies after the enum rename.
do $$ declare r record; begin
 for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='app' and p.prokind='f' and pg_get_functiondef(p.oid) like '%作業中%' loop
 execute replace(pg_get_functiondef(r.oid),'作業中','受取前');
 end loop;
end $$;
alter table app.items add column if not exists return_request_completed_at timestamptz;
alter table app.items add column if not exists marketplace_status_observed_at timestamptz;
drop trigger if exists items_create_delivery_return_request_task on app.items;
-- Preserve completed request history; no further return-request tasks are generated.
update app.items i set return_request_completed_at=x.completed_at
from (select item_id,max(completed_at) completed_at from app.delivery_return_request_tasks
where completed_at is not null group by item_id) x where i.id=x.item_id;
create or replace function app.items_sync_status() returns trigger
language plpgsql set search_path=pg_catalog,app as $$
declare explicit_change boolean:=false; parent_status app.item_status;
begin
 if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.cost_amount:=0;end if;
 if new.is_accessory and new.parent_item_id is not null and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   select status into parent_status from app.items where id=new.parent_item_id;
   if found then new.status:=parent_status;return new;end if;
 end if;
 -- Sale dates always win, including delayed browser snapshots and photo actions.
 if new.sold_on is not null then new.status:='販売済';return new;end if;
 if new.status='返品処理' or new.returned_on is not null then new.status:='返品処理';return new;end if;
 if tg_op='UPDATE' then explicit_change:=new.status is distinct from old.status;end if;
 if explicit_change then
   if new.marketplace_status_observed_at is not distinct from old.marketplace_status_observed_at then new.marketplace_status_observed_at:=now();end if;
   if new.status='販売済' then
     new.sold_on:=(now() at time zone 'Asia/Tokyo')::date;
     new.sold_price:=0;new.payout_amount:=0;return new;
   elsif new.status='Amazon返送依頼' then new.return_request_completed_at:=null;return new;
   elsif new.status='検品中' then
     if new.marketplace not in ('Amazon返品','動作品Amazon返品') and nullif(btrim(new.tracking_no),'') is null then raise exception '検品中にするには追跡番号を登録してください' using errcode='22023';end if;
     if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.return_request_completed_at:=coalesce(new.return_request_completed_at,now());end if;
     new.inspected_at:=null;new.cleaned_at:=null;new.product_registered_at:=null;
     return new;
   elsif new.status='商品登録前' then
     new.product_registered_at:=null;new.inspected_at:=coalesce(new.inspected_at,now());
     new.malfunction_resolved_at:=case when new.malfunction_reported then coalesce(new.malfunction_resolved_at,now()) else new.malfunction_resolved_at end;
     return new;
   elsif new.status='出品中' then
     new.product_registered_at:=coalesce(new.product_registered_at,now());return new;
   elsif new.status='動作不良' then new.malfunction_reported:=true;new.malfunction_resolved_at:=null;return new;
   elsif new.status in ('取引中','Amazon補填申請中') then return new;
   end if;
 end if;
 -- These stages require a business decision, not a shipping/photo timestamp.
 if tg_op='UPDATE' and new.sales_channel is not distinct from old.sales_channel
 and new.status in ('取引中','Amazon補填申請中')
 and new.malfunction_reported is not distinct from old.malfunction_reported then return new;end if;
 if tg_op='UPDATE' and not explicit_change and new.status='出品中'
 and new.product_registered_at is not distinct from old.product_registered_at
 and new.sales_channel is not distinct from old.sales_channel
 and not coalesce(new.malfunction_reported and new.malfunction_resolved_at is null,false) then return new;end if;
 if new.malfunction_reported and new.malfunction_resolved_at is null then new.status:='動作不良';
 elsif new.product_registered_at is not null then new.status:='出品中';
 elsif new.inspected_at is not null or (new.malfunction_resolved_at is not null and new.sales_channel='ヤフオク') then new.status:='商品登録前';
 elsif new.marketplace in ('Amazon返品','動作品Amazon返品') then
   new.status:=case when new.return_request_completed_at is not null then '検品中'::app.item_status else 'Amazon返送依頼'::app.item_status end;
 elsif nullif(btrim(new.tracking_no),'') is not null then new.status:='検品中';
 else new.status:='受取前';end if;
 return new;
end $$;
drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status before insert or update of status,tracking_no,marketplace,sales_channel,
 product_registered_at,inspected_at,cleaned_at,photo_uploaded_at,packed_on,shipped_on,listed_on,
 amazon_returned_on,sold_on,returned_on,malfunction_reported,malfunction_resolved_at,return_request_completed_at
 on app.items for each row execute function app.items_sync_status();

-- Computed status changes (inspection/tracking/fault reports) also synchronize children.
do $$declare d text;begin
 d:=pg_get_functiondef('app.sync_accessory_sale_date()'::regprocedure);
 d:=replace(d,'pg_trigger_depth() > 1 or new.is_accessory','new.is_accessory');
 execute d;
end $$;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date after update on app.items
for each row execute function app.sync_accessory_sale_date();

-- Sale-date trigger must agree with the central workflow; supplier returns have no sale date.
create or replace function app.items_mark_sold() returns trigger language plpgsql set search_path='' as $$
begin
 if new.sold_on is not null then new.status:='販売済';
 elsif new.returned_on is not null then new.status:='返品処理';end if;
 return new;
end $$;
-- Incorrect reports explicitly identified by the user. Retain the report text/history.
update app.items set malfunction_reported=false where not is_accessory and split_part(sku,'-',1) in ('2393','2397');
-- Close non-sale predecessor stages only. Real historical sale amounts are never overwritten.
update app.items i set sold_on=coalesce(i.sold_on,(now() at time zone 'Asia/Tokyo')::date),sold_price=0,payout_amount=0,status='販売済'
where not i.is_accessory and i.status<>'返品処理'
and (i.sold_on is null or (coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0))
and exists(select 1 from app.items b where not b.is_accessory and b.marketplace='動作品Amazon返品'
 and app.financial_product_serial(b.sku,b.lot_seq)=app.financial_product_serial(i.sku,i.lot_seq) and b.id<>i.id
 and (i.created_at<b.created_at or (i.created_at=b.created_at and length(split_part(i.sku,'-',1))<length(split_part(b.sku,'-',1)))));
-- Reclassify legacy active work from existing facts, not shipment dates.
update app.items set tracking_no=tracking_no where not is_accessory and status='受取前';
-- Parent changes already synchronize; repair any pre-existing accessory status differences.
update app.items a set status=p.status from app.items p where a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and a.parent_item_id=p.id and a.status is distinct from p.status;
-- Remove the obsolete four-status whitelist without changing the view's RLS boundary.
do $$ declare d text; begin
 d:=pg_get_viewdef('app.v_delivery_tasks'::regclass,true);
 d:=regexp_replace(d,'\(i.status = ANY \(ARRAY\[[^]]+\]\)\) AND ','');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as '||d;
end $$;
-- The old task view is retained only for compatibility and no longer exposes tasks.
create or replace view app.v_delivery_return_request_tasks with(security_invoker=true) as
select t.id,t.item_id,i.sku,i.lot_seq,i.title,p.model_no,i.asin,i.deliverer_id,t.created_at,t.completed_at
from app.delivery_return_request_tasks t join app.items i on i.id=t.item_id left join app.products p on p.id=i.product_id where false;
-- Rename aggregate fields so the retired wording is absent from all current clients.
alter view app.v_stock_summary rename column "作業中" to "保有在庫";
create or replace view app.v_stock_summary as
with current_items as (
 select distinct on (app.financial_product_serial(i.sku,i.lot_seq)) i.*,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key
 from app.items i where not i.is_accessory and i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良') and i.sold_on is null
 order by app.financial_product_serial(i.sku,i.lot_seq),i.purchased_at desc nulls last,i.created_at desc,i.id
)
select count(*) as "現在庫数",coalesce(sum(f.family_cost),0)::numeric as "仕入金額合計",
 coalesce(sum(coalesce(i.planned_payout,0)),0)::numeric as "売上見込み合計",
 coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,0)-f.family_cost+coalesce(realized.allocated_cost,0)),0)::numeric as "見込み利益合計",
 count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
 count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
 count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
 count(*) as "保有在庫",
 count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using(family_key)
left join (select family_key,sum(profit) as profit,sum(cost_amount) as allocated_cost from app.v_financial_sales group by family_key) realized using(family_key);


drop view app.v_deliverer_workload;
create view app.v_deliverer_workload with(security_invoker=true,security_barrier=true) as
with dates as(select (now() at time zone 'Asia/Tokyo')::date today,
((now() at time zone 'Asia/Tokyo')::date-interval '3 months')::date average_start)
select s.id deliverer_id,s.name deliverer_name,
count(*) filter(where not i.is_accessory and i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良')) as "保有在庫",
avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active and (select app.management_reports_allowed()) group by s.id,s.name;
revoke all on app.v_deliverer_workload from public,anon;grant select on app.v_deliverer_workload to authenticated;
do $$ declare d text;begin
 d:=pg_get_viewdef('app.v_stock_summary'::regclass,true);
 execute 'create or replace view app.v_stock_summary with(security_invoker=true,security_barrier=true) as select report.* from ('||rtrim(btrim(d),';')||') report where (select app.management_reports_allowed())';
end $$;
-- Explicit, authorized transitions used by inventory details (not a task).
create or replace function app.set_inventory_workflow(p_item_id uuid,p_status app.item_status)
returns void language plpgsql security definer set search_path='' as $$
declare i app.items; actor uuid:=app.current_staff_id();
begin
 if auth.uid() is null or actor is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if not found or not coalesce(app.is_admin() or i.deliverer_id=actor or (app.current_role()='purchaser' and i.purchaser_id=actor),false) then
 raise exception 'この商品の状態を変更できません' using errcode='42501';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から変更してください' using errcode='22023';end if;
 if i.sold_on is not null and p_status<>'販売済' then raise exception '販売日がある商品は販売済です' using errcode='22023';end if;
 if p_status='販売済' then
   if i.sold_on is not null then return;end if;
   update app.items set sold_on=(now() at time zone 'Asia/Tokyo')::date,sold_price=0,payout_amount=0,status='販売済' where id=i.id;
 else
   update app.items set status=p_status where id=i.id;
 end if;
end $$;
revoke all on function app.set_inventory_workflow(uuid,app.item_status) from public,anon;
grant execute on function app.set_inventory_workflow(uuid,app.item_status) to authenticated;
-- A mistaken malfunction report can be returned to the appropriate inspection stage.
create or replace function app.resolve_item_malfunction(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=app.current_staff_id();begin
 if auth.uid() is null or not coalesce(app.is_admin() or (app.current_role()='purchaser' and exists(select 1 from app.items where id=p_item_id and purchaser_id=actor)),false) then
 raise exception '対象商品の仕入担当者または管理者のみ差し戻しできます' using errcode='42501';end if;
 update app.items set malfunction_reported=false,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor
 where id=p_item_id and malfunction_reported and malfunction_resolved_at is null;
 if not found then raise exception '未対応の動作不良報告が見つかりません' using errcode='P0002';end if;
end $$;
-- Authenticated extension snapshots are exact-serial and sales-channel scoped.
create or replace function app.sync_marketplace_sale_status(p_channel text,p_serial text,p_status text,p_observed_at timestamptz)
returns text language plpgsql security definer set search_path='' as $$
declare i app.items;actor uuid:=app.current_staff_id();n integer;
begin
 if auth.uid() is null or not coalesce(app.current_role() in ('admin','purchaser'),false) then raise exception '権限がありません' using errcode='42501';end if;
 if p_channel not in ('メルカリ','ヤフオク') or p_status not in ('出品中','取引中')
 or p_serial !~ '^[0-9]+[a-z]*$' or p_observed_at is null or p_observed_at>now()+interval '5 minutes' or p_observed_at<now()-interval '1 day' then
 raise exception '取得情報を確認してください' using errcode='22023';end if;
 select count(*) into n from app.items where not is_accessory and split_part(sku,'-',1)=p_serial and sales_channel::text=p_channel
 and (app.is_admin() or purchaser_id=actor);
 if n<>1 then return 'unmatched';end if;
 select * into i from app.items where not is_accessory and split_part(sku,'-',1)=p_serial and sales_channel::text=p_channel
 and (app.is_admin() or purchaser_id=actor) for update;
 if i.sold_on is not null or i.status in ('販売済','返品処理','Amazon補填申請中','動作不良') then return 'protected';end if;
 if i.marketplace_status_observed_at is not null and i.marketplace_status_observed_at>=p_observed_at then return 'stale';end if;
 update app.items set status=p_status::app.item_status,marketplace_status_observed_at=p_observed_at where id=i.id;
 return 'updated';
end $$;
revoke all on function app.sync_marketplace_sale_status(text,text,text,timestamptz) from public,anon;
grant execute on function app.sync_marketplace_sale_status(text,text,text,timestamptz) to authenticated;
notify pgrst,'reload schema';

-- Future return stages close only non-sale predecessors in the same normal/A/B family.
create or replace function app.close_non_sale_predecessors() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if new.is_accessory or new.marketplace<>'動作品Amazon返品' then return new;end if;
 update app.items i set sold_on=coalesce(i.sold_on,(now() at time zone 'Asia/Tokyo')::date),sold_price=0,payout_amount=0,status='販売済'
 where not i.is_accessory and i.status<>'返品処理'
 and app.financial_product_serial(i.sku,i.lot_seq)=app.financial_product_serial(new.sku,new.lot_seq)
 and i.id<>new.id and (i.created_at<new.created_at or (i.created_at=new.created_at and length(split_part(i.sku,'-',1))<length(split_part(new.sku,'-',1))))
 and (i.sold_on is null or (coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0));
 return new;
end $$;
revoke all on function app.close_non_sale_predecessors() from public,anon;
create trigger items_close_non_sale_predecessors after insert on app.items for each row execute function app.close_non_sale_predecessors();


-- ▼▼▼ 20261016000532_paged_inventory_sync.sql ▼▼▼

-- Read-only, RLS-preserving snapshots. A page is a prefix of complete serial groups.
-- Fingerprints include joined catalog/comments/photo metadata, not just items.updated_at.
create or replace function app.inventory_page_matches(d jsonb,f jsonb,scope text)
returns boolean language plpgsql immutable set search_path=pg_catalog,app as $$
declare field text; needle text; candidate text; serial text; values jsonb;
begin
 foreach field in array array['status','marketplace','sales_channel'] loop
  values:=f->'states'->field;
  if jsonb_typeof(values)='array' and jsonb_array_length(values)>0 and not values ? coalesce(d->>field,'') then return false;end if;
 end loop;
 if nullif(f->>'status','') is not null and f->>'status'<>'all' and d->>'status'<>f->>'status' then return false;end if;
 if nullif(f->>'delivererId','') is not null and coalesce(d->>'deliverer_id','')<>f->>'delivererId' then return false;end if;
 if nullif(f->>'from','') is not null and coalesce(d->>'purchased_at','')<f->>'from' then return false;end if;
 if nullif(f->>'to','') is not null and (d->>'purchased_at' is null or d->>'purchased_at'>f->>'to') then return false;end if;
 field:=coalesce(f->>'queryField','serial');needle:=coalesce(f->>'query','');
 if scope='delivery' then needle:=regexp_replace(lower(normalize(needle,NFKC)),'[[:space:]‐‑–—−ー]','','g');else needle:=lower(btrim(needle));end if;
 if needle='' or field='deliverer' then return true;end if;
 serial:=coalesce(substring(d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]'),d->>'lot_seq');
 candidate:=case field when 'serial' then serial when 'model' then
  case when scope='management' and (d->>'is_accessory')::boolean then d->>'title'
   else coalesce(nullif(btrim(d->>'model_no'),''),case when d->>'marketplace'='動作品Amazon返品' then '未登録' else coalesce(nullif(btrim(d->>'title'),''),'—') end) end
  when 'marketplace_item_id' then case when scope='delivery' and d->>'marketplace'<>'動作品Amazon返品' then coalesce(nullif(d->>'original_marketplace_item_id',''),d->>'marketplace_item_id') else d->>'marketplace_item_id' end
  when 'sku' then d->>'sku' when 'asin' then d->>'asin' when 'tracking_no' then d->>'tracking_no' else '' end;
 if scope='delivery' then candidate:=regexp_replace(lower(normalize(coalesce(candidate,''),NFKC)),'[[:space:]‐‑–—−ー]','','g');else candidate:=lower(coalesce(candidate,''));end if;
 if field='serial' then
  needle:=lower(btrim(normalize(needle,NFKC)));
  if needle ~ '^[0-9]+$' then return candidate ~ ('^'||needle||'[a-z]*$');end if;
  return candidate=needle;
 end if;
 return position(needle in candidate)>0;
end $$;
revoke all on function app.inventory_page_matches(jsonb,jsonb,text) from public,anon;
grant execute on function app.inventory_page_matches(jsonb,jsonb,text) to authenticated;

create or replace function app.read_inventory_page(p_scope text,p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare source text; result jsonb; query text;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_scope not in ('delivery','management') or p_limit<1 or p_limit>10000 or jsonb_typeof(p_filters)<>'object' or jsonb_typeof(p_known)<>'object' then raise exception '取得条件を確認してください' using errcode='22023';end if;
 -- Only whitelisted view names are interpolated; filters and fingerprints stay parameters.
 source:=case when p_scope='delivery' then 'app.v_delivery_tasks' else 'app.v_inventory_display' end;
 query:=format($query$
 with raw as materialized (select to_jsonb(v) d from %s v),
 data as materialized (
  select r.d || case when $1='delivery' then jsonb_build_object('original_marketplace_item_id',
   (select o.d->>'marketplace_item_id' from raw o where not (o.d->>'is_accessory')::boolean
    and o.d->>'lot_seq'=r.d->>'lot_seq' and o.d->>'sku' ~ '^[0-9]+-' and nullif(o.d->>'marketplace_item_id','') is not null order by o.d->>'id' limit 1)) else '{}'::jsonb end d,
   coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq') serial
  from raw r
 ),
 matched as materialized (select * from data where app.inventory_page_matches(d,$2,$1)),
 groups as (select serial,max((d->>'lot_seq')::integer) lot,max(d->>'purchased_at') purchased from matched group by serial),
 page_groups as (select * from groups order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial limit $3),
 page as materialized (
  select d.*,md5(d.d::text) fingerprint,g.lot,g.purchased from
  (select * from data where $1='delivery' union all select * from matched where $1='management') d
  join page_groups g using(serial)
 ),
 ordered as (select *,row_number() over(order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial,(d->>'is_accessory')::boolean,d->>'id') n from page)
 select jsonb_build_object(
  'total',(select count(*) from groups),
  'ids',coalesce(jsonb_agg(d->>'id' order by n),'[]'::jsonb),
  'fingerprints',coalesce(jsonb_object_agg(d->>'id',fingerprint),'{}'::jsonb),
  'rows',coalesce(jsonb_agg(d order by n) filter(where ($4->>(d->>'id')) is distinct from fingerprint),'[]'::jsonb)
 ) from ordered
 $query$,source);
 execute query into result using p_scope,coalesce(p_filters,'{}'),p_limit,coalesce(p_known,'{}');
 return result;
end $$;
revoke all on function app.read_inventory_page(text,jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_inventory_page(text,jsonb,integer,jsonb) to authenticated;


-- ▼▼▼ 20261016001150_inventory_page_reference_fields.sql ▼▼▼

-- Preserve assignee labels and working-return tracking, using one origin lookup per serial.
create or replace function app.read_inventory_page(p_scope text,p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare source text; result jsonb; query text;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_scope not in ('delivery','management') or p_limit<1 or p_limit>10000 or jsonb_typeof(p_filters)<>'object' or jsonb_typeof(p_known)<>'object' then raise exception '取得条件を確認してください' using errcode='22023';end if;
 -- Only whitelisted view names are interpolated; filters and fingerprints stay parameters.
 source:=case when p_scope='delivery' then 'app.v_delivery_tasks' else 'app.v_inventory_display' end;
 query:=format($query$
 with raw as materialized (select to_jsonb(v) d from %s v),
 origins as (select distinct on (d->>'lot_seq') d->>'lot_seq' lot,d->>'marketplace_item_id' item_id from raw
  where not (d->>'is_accessory')::boolean and d->>'sku' ~ '^[0-9]+-' and nullif(d->>'marketplace_item_id','') is not null order by d->>'lot_seq',d->>'id'),
 data as materialized (
  select r.d || case when $1='delivery' then jsonb_build_object(
   'original_marketplace_item_id',o.item_id,'deliverer_name',s.name,
   'tracking_no',coalesce(nullif(r.d->>'tracking_no',''),case when r.d->>'marketplace'='動作品Amazon返品' and btrim(r.d->>'title') ~ '^X[A-Z0-9]{9}$' then btrim(r.d->>'title') else r.d->>'tracking_no' end)) else '{}'::jsonb end d,
   coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq') serial
  from raw r left join origins o on $1='delivery' and o.lot=r.d->>'lot_seq'
  left join app.staff s on $1='delivery' and s.id::text=r.d->>'deliverer_id'
 ),
 matched as materialized (select * from data where app.inventory_page_matches(d,$2,$1)),
 groups as (select serial,max((d->>'lot_seq')::integer) lot,max(d->>'purchased_at') purchased from matched group by serial),
 page_groups as (select * from groups order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial limit $3),
 page as materialized (
  select d.*,md5(d.d::text) fingerprint,g.lot,g.purchased from
  (select * from data where $1='delivery' union all select * from matched where $1='management') d
  join page_groups g using(serial)
 ),
 ordered as (select *,row_number() over(order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial,(d->>'is_accessory')::boolean,d->>'id') n from page)
 select jsonb_build_object(
  'total',(select count(*) from groups),
  'ids',coalesce(jsonb_agg(d->>'id' order by n),'[]'::jsonb),
  'fingerprints',coalesce(jsonb_object_agg(d->>'id',fingerprint),'{}'::jsonb),
  'rows',coalesce(jsonb_agg(d order by n) filter(where ($4->>(d->>'id')) is distinct from fingerprint),'[]'::jsonb)
 ) from ordered
 $query$,source);
 execute query into result using p_scope,coalesce(p_filters,'{}'),p_limit,coalesce(p_known,'{}');
 return result;
end $$;
revoke all on function app.read_inventory_page(text,jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_inventory_page(text,jsonb,integer,jsonb) to authenticated;


-- ▼▼▼ 20261016002203_unchanged_inventory_revision.sql ▼▼▼

-- A stable page revision avoids repeating IDs/hashes when no visible data changed.
-- Preserve assignee labels and working-return tracking, using one origin lookup per serial.
create or replace function app.read_inventory_page(p_scope text,p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare source text; result jsonb; query text;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_scope not in ('delivery','management') or p_limit<1 or p_limit>10000 or jsonb_typeof(p_filters)<>'object' or jsonb_typeof(p_known)<>'object' then raise exception '取得条件を確認してください' using errcode='22023';end if;
 -- Only whitelisted view names are interpolated; filters and fingerprints stay parameters.
 source:=case when p_scope='delivery' then 'app.v_delivery_tasks' else 'app.v_inventory_display' end;
 query:=format($query$
 with raw as materialized (select to_jsonb(v) d from %s v),
 origins as (select distinct on (d->>'lot_seq') d->>'lot_seq' lot,d->>'marketplace_item_id' item_id from raw
  where not (d->>'is_accessory')::boolean and d->>'sku' ~ '^[0-9]+-' and nullif(d->>'marketplace_item_id','') is not null order by d->>'lot_seq',d->>'id'),
 data as materialized (
  select r.d || case when $1='delivery' then jsonb_build_object(
   'original_marketplace_item_id',o.item_id,'deliverer_name',s.name,
   'tracking_no',coalesce(nullif(r.d->>'tracking_no',''),case when r.d->>'marketplace'='動作品Amazon返品' and btrim(r.d->>'title') ~ '^X[A-Z0-9]{9}$' then btrim(r.d->>'title') else r.d->>'tracking_no' end)) else '{}'::jsonb end d,
   coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq') serial
  from raw r left join origins o on $1='delivery' and o.lot=r.d->>'lot_seq'
  left join app.staff s on $1='delivery' and s.id::text=r.d->>'deliverer_id'
 ),
 matched as materialized (select * from data where app.inventory_page_matches(d,$2,$1)),
 groups as (select serial,max((d->>'lot_seq')::integer) lot,max(d->>'purchased_at') purchased from matched group by serial),
 page_groups as (select * from groups order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial limit $3),
 page as materialized (
  select d.*,md5(d.d::text) fingerprint,g.lot,g.purchased from
  (select * from data where $1='delivery' union all select * from matched where $1='management') d
  join page_groups g using(serial)
 ),
 ordered as (select *,row_number() over(order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial,(d->>'is_accessory')::boolean,d->>'id') n from page)
 , summary as (select jsonb_build_object(
  'total',(select count(*) from groups),
  'ids',coalesce(jsonb_agg(d->>'id' order by n),'[]'::jsonb),
  'fingerprints',coalesce(jsonb_object_agg(d->>'id',fingerprint),'{}'::jsonb),
  'rows',coalesce(jsonb_agg(d order by n) filter(where ($4->>(d->>'id')) is distinct from fingerprint),'[]'::jsonb)
 ) payload,md5((select count(*)::text from groups)||':'||coalesce(string_agg((d->>'id')||fingerprint,',' order by n),'')) revision from ordered)
 select case when $4->>'__revision'=revision then jsonb_build_object('total',payload->'total','unchanged',true,'revision',revision,'ids','[]'::jsonb,'rows','[]'::jsonb,'fingerprints','{}'::jsonb)
 else payload||jsonb_build_object('unchanged',false,'revision',revision) end from summary
 $query$,source);
 execute query into result using p_scope,coalesce(p_filters,'{}'),p_limit,coalesce(p_known,'{}');
 return result;
end $$;
revoke all on function app.read_inventory_page(text,jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_inventory_page(text,jsonb,integer,jsonb) to authenticated;


-- ▼▼▼ 20261016002422_inventory_page_management_guard.sql ▼▼▼

-- The unified management mode is available only to administrators/purchasers.
-- Enforce the same boundary at the new reader, independently of legacy view grants.
do $guard$
declare definition text; marker text:=' -- Only whitelisted view names';
begin
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Inventory reader guard insertion point missing';end if;
 definition:=replace(definition,marker,
 ' if p_scope=''management'' and not coalesce(app.current_role() in (''admin'',''purchaser''),false) then raise exception ''管理機能の在庫を閲覧する権限がありません'' using errcode=''42501'';end if;'
 ||chr(10)||marker);
 execute definition;
end $guard$;


-- ▼▼▼ 20261016003637_resource_snapshot_and_product_summary.sql ▼▼▼

-- Compact conditional reads preserve existing table/view RLS and role restrictions.
create or replace function app.read_resource_snapshot(p_resource text,p_filters jsonb default '{}',p_known jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare source text; result jsonb;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_resource in ('invoice_tasks','photo_reviews','listing_tasks','actions') and not app.is_admin() then raise exception '管理者のみ閲覧できます' using errcode='42501';end if;
 case p_resource
 when 'spares' then source:=$q$select to_jsonb(s)||jsonb_build_object('_owner_code',p.code) d from app.spare_accessories s left join app.staff p on p.id=s.owner_staff_id where s.used_for_item_id is null and (nullif($1->>'owner','') is null or s.owner_staff_id::text=$1->>'owner')$q$;
 when 'shipping' then source:=$q$select to_jsonb(s) d from app.v_spare_shipping_tasks s where completed_at is null$q$;
 when 'actions' then source:=$q$select to_jsonb(s) d from app.v_item_action_tasks s where task_completed_at is null$q$;
 when 'malfunctions' then source:=$q$select to_jsonb(s) d from (select i.id,i.sku,i.lot_seq,i.title,i.asin,i.marketplace_item_id,i.purchaser_id,i.deliverer_id,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_reported_by,
 jsonb_build_array(jsonb_build_object('model_no',p.model_no)) products,a.maker maker,
 jsonb_build_array(jsonb_build_object('id',b.id,'name',b.name),jsonb_build_object('id',d.id,'name',d.name),jsonb_build_object('id',r.id,'name',r.name)) people
 from app.items i left join app.products p on p.id=i.product_id left join app.products a on a.asin=i.asin and a.is_active
 left join app.staff b on b.id=i.purchaser_id left join app.staff d on d.id=i.deliverer_id left join app.staff r on r.id=i.malfunction_reported_by
 where i.malfunction_reported and i.malfunction_resolved_at is null and (app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))) s$q$;
 when 'photo_reviews' then source:=$q$select jsonb_build_object('id',r.item_id,'item_id',r.item_id,'drive_folder_id',r.drive_folder_id,'submitted_at',r.submitted_at,'exported_photo_count',r.exported_photo_count,'item',jsonb_build_object('id',i.id,'sku',i.sku,'title',i.title,'lot_seq',i.lot_seq)) d from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is null$q$;
 when 'listing_tasks' then source:=$q$select to_jsonb(i) d from (select i.id,i.sku,i.lot_seq,i.sales_channel from app.items i join app.photo_reviews r on r.item_id=i.id where r.approved_at is not null and i.sales_channel in ('メルカリ','ヤフオク') and i.status='商品登録前' and i.sold_on is null) i$q$;
 when 'invoice_tasks' then source:=$q$select jsonb_build_object('id',coalesce(i.staff_id,s.staff_id)::text||'/'||coalesce(i.billing_month,s.billing_month)::text,'staff_id',coalesce(i.staff_id,s.staff_id),'month',coalesce(i.billing_month,s.billing_month),'name',coalesce(i.snapshot->'profile'->>'issuer_name',p.details->>'issuer_name','担当者'),'updated',greatest(i.updated_at,s.submitted_at),
 'invoice',case when i.id is null then null else to_jsonb(i)||jsonb_build_object('delivery_invoice_approvals',(select to_jsonb(a) from app.delivery_invoice_approvals a where a.invoice_id=i.id limit 1)) end,'receipts',to_jsonb(s)) d
 from app.delivery_invoices i full join app.invoice_receipt_submissions s on s.staff_id=i.staff_id and s.billing_month=i.billing_month left join app.delivery_invoice_profiles p on p.staff_id=coalesce(i.staff_id,s.staff_id)$q$;
 else raise exception '取得対象を確認してください' using errcode='22023';end case;
 execute 'with rows as materialized (select d,md5(d::text) hash from ('||source||') source),summary as(select coalesce(jsonb_agg(d->>''id'' order by d->>''id''),''[]''::jsonb) ids,coalesce(jsonb_object_agg(d->>''id'',hash),''{}''::jsonb) fingerprints,coalesce(jsonb_agg(d order by d->>''id'') filter(where ($2->>(d->>''id'')) is distinct from hash),''[]''::jsonb) rows,md5(coalesce(string_agg((d->>''id'')||hash,'','' order by d->>''id''),'''')) revision from rows)
 select case when $2->>''__revision''=revision then jsonb_build_object(''unchanged'',true,''revision'',revision,''ids'',''[]''::jsonb,''rows'',''[]''::jsonb,''fingerprints'',''{}''::jsonb)
 else jsonb_build_object(''unchanged'',false,''revision'',revision,''ids'',ids,''rows'',rows,''fingerprints'',fingerprints) end from summary'
 into result using coalesce(p_filters,'{}'),coalesce(p_known,'{}');return result;
end $$;
revoke all on function app.read_resource_snapshot(text,jsonb,jsonb) from public,anon;
grant execute on function app.read_resource_snapshot(text,jsonb,jsonb) to authenticated;

-- Keep the product-list average identical to the prior latest-three Amazon calculation.
create or replace function app.product_sale_summaries(p_product_ids uuid[])
returns jsonb language sql stable security invoker set search_path=pg_catalog,app as $$
 with sales as (
 select p.id product_id,i.id,i.sold_on,i.sold_price,i.sales_channel from app.products p join app.items i on i.product_id=p.id or (i.product_id is null and i.asin=p.asin)
 where p.id=any(p_product_ids) and not i.is_accessory and i.sold_on is not null
 ),amazon as(select *,row_number() over(partition by product_id order by sold_on desc,id) n from sales where sales_channel in ('FBA','自己発送') and sold_price is not null)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',p.id,'history_count',(select count(*) from sales s where s.product_id=p.id),'amazon_count',(select count(*) from amazon a where a.product_id=p.id and n<=3),'amazon_average',(select floor(avg(sold_price)+0.5) from amazon a where a.product_id=p.id and n<=3))),'[]'::jsonb)
 from app.products p where p.id=any(p_product_ids) and auth.uid() is not null
$$;
revoke all on function app.product_sale_summaries(uuid[]) from public,anon;
grant execute on function app.product_sale_summaries(uuid[]) to authenticated;

-- List rows carry a revision of detail-only text, so an open detail can revalidate it.
do $$declare definition text;marker text:='coalesce(jsonb_agg(d order by n) filter';begin
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Inventory projection insertion point missing';end if;
 definition:=replace(definition,marker,$replacement$coalesce(jsonb_agg(case when $1='delivery' then (d-'description'-'malfunction_comment')||jsonb_build_object('description',null,'malfunction_comment',null,'summary_only',true,'detail_revision',md5(jsonb_build_array(d->'description',d->'malfunction_comment')::text)) else d end order by n) filter$replacement$);
 execute definition;
end $$;


-- ▼▼▼ 20261016075033_state_specific_actions_and_seller_links.sql ▼▼▼

-- State-specific commands are the delivery write boundary. Every transition is locked,
-- checks its source status and actor, and keeps an immutable local action history.
alter table app.items add column if not exists supplier_contact_requested_at timestamptz;
alter table app.items add column if not exists workflow_decision text;
alter table app.items add column if not exists workflow_previous_sales_channel app.sales_channel;
alter table app.items add column if not exists seller_trade_key text;
alter table app.items add column if not exists seller_cancelled_trade_key text;
alter table app.items add column if not exists seller_cancelled_at timestamptz;
alter table app.items add column if not exists seller_message_attention boolean not null default false;
create table app.inventory_workflow_events(
 id uuid primary key, item_id uuid not null references app.items(id) on delete cascade, actor_id uuid not null references app.staff(id),
 action text not null, from_status app.item_status not null,to_status app.item_status not null,
 note text, created_at timestamptz not null default clock_timestamp()
);
create index inventory_workflow_events_item_time on app.inventory_workflow_events(item_id,created_at desc);
alter table app.inventory_workflow_events enable row level security;
revoke all on app.inventory_workflow_events from public,anon,authenticated;
grant select on app.inventory_workflow_events to authenticated;
create policy inventory_workflow_events_read on app.inventory_workflow_events for select to authenticated using(exists(
 select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))));

create or replace function app.perform_inventory_action(p_item_id uuid,p_action text,p_expected_status app.item_status,p_note text default null,p_request_id uuid default gen_random_uuid())
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;actor uuid:=app.current_staff_id();manager boolean;target app.item_status;old_event app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 manager:=coalesce(app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=actor),false);
 if i.id is null or not coalesce(manager or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から操作してください' using errcode='22023';end if;
 if p_request_id is null then raise exception '操作IDがありません' using errcode='22023';end if;
 select * into old_event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if old_event.item_id=i.id and old_event.actor_id=actor and old_event.action=p_action and old_event.note is not distinct from nullif(btrim(p_note),'') then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';
 end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('running','uncertain')) or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('running','uncertain')) then raise exception '実行中の操作の結果を確認してから状態を変更してください';end if;
 if i.sold_on is not null or i.status='販売済' then raise exception '販売済の商品は管理機能で販売日を訂正してください' using errcode='22023';end if;
 if i.status is distinct from p_expected_status then raise exception '状態が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 if length(coalesce(p_note,''))>2000 then raise exception '2000文字以内で入力してください' using errcode='22023';end if;
 target:=i.status;
 case p_action
 when 'return_request_complete' then
  if i.status<>'Amazon返送依頼' or i.marketplace not in ('Amazon返品','動作品Amazon返品') then raise exception '返送依頼待ちの商品ではありません';end if;
  target:='検品中';update app.items set return_request_completed_at=clock_timestamp(),status=target where id=i.id;
 when 'return_request_cancel' then
  if i.status<>'検品中' or i.marketplace not in ('Amazon返品','動作品Amazon返品') then raise exception '返送依頼の取消対象ではありません';end if;
  target:='Amazon返送依頼';update app.items set return_request_completed_at=null,status=target where id=i.id;
 when 'inspection_complete' then
  if i.status<>'検品中' then raise exception '検品中の商品ではありません';end if;
  target:='商品登録前';update app.items set inspected_at=coalesce(inspected_at,clock_timestamp()),cleaned_at=coalesce(cleaned_at,clock_timestamp()),status=target where id=i.id;
 when 'inspection_cancel' then
  if i.status<>'商品登録前' or i.workflow_decision is not null then raise exception '検品完了の取消対象ではありません';end if;
  target:='検品中';update app.items set inspected_at=null,cleaned_at=null,product_registered_at=null,status=target where id=i.id;
 when 'report' then
  if i.status<>'検品中' or nullif(btrim(p_note),'') is null then raise exception '検品中の商品について報告内容を入力してください';end if;
  target:=case when i.marketplace in ('Amazon返品','動作品Amazon返品') then 'Amazon補填申請中'::app.item_status else '動作不良'::app.item_status end;
  update app.items set malfunction_reported=true,malfunction_comment=btrim(p_note),malfunction_reported_at=clock_timestamp(),malfunction_reported_by=actor,malfunction_resolved_at=null,malfunction_resolved_by=null,status=target where id=i.id;
 when 'report_cancel','send_back' then
  if i.status not in ('動作不良','Amazon補填申請中') then raise exception '報告の取消対象ではありません';end if;
  if p_action='send_back' and not manager then raise exception '管理者・仕入担当者のみ差し戻しできます' using errcode='42501';end if;
  if i.status='Amazon補填申請中' and not manager then raise exception '破損報告の差し戻しは管理側から行ってください' using errcode='42501';end if;
  target:='検品中';update app.items set malfunction_reported=false,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,supplier_contact_requested_at=null,workflow_decision=null,status=target where id=i.id;
 when 'supplier_check' then
  if not manager then raise exception '管理者・仕入担当者のみ操作できます' using errcode='42501';end if;
  if i.status<>'動作不良' then raise exception '動作不良の商品ではありません';end if;
  update app.items set supplier_contact_requested_at=clock_timestamp() where id=i.id;
  insert into app.item_comments(item_id,author_id,body,task_kind) values(i.id,actor,'仕入先へ確認します。','仕入先確認');
 when 'supplier_return_complete' then
  if i.status<>'動作不良' or i.supplier_contact_requested_at is null then raise exception '仕入先確認後に返品完了を登録してください';end if;
  target:='返品処理';update app.items set returned_on=(clock_timestamp() at time zone 'Asia/Tokyo')::date,status=target where id=i.id;
 when 'supplier_return_cancel' then
  if i.status<>'返品処理' or i.marketplace in ('Amazon返品','動作品Amazon返品') then raise exception '返品完了の取消対象ではありません';end if;
  target:='動作不良';update app.items set returned_on=null,malfunction_reported=true,malfunction_resolved_at=null,status=target where id=i.id;
 when 'return_impossible','yahoo_instruction' then
  if i.status<>'動作不良' or (p_action='return_impossible' and i.supplier_contact_requested_at is null) then raise exception '動作不良の商品で仕入先確認後に操作してください';end if;
  if p_action='yahoo_instruction' and not manager then raise exception '販売指示は管理側から行ってください' using errcode='42501';end if;
  target:='商品登録前';update app.items set workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status=target where id=i.id;
 when 'yahoo_instruction_cancel' then
  if i.status<>'商品登録前' or i.workflow_decision is distinct from 'yahoo' then raise exception '返品不可・販売指示の取消対象ではありません';end if;
  target:='動作不良';update app.items set sales_channel=coalesce(workflow_previous_sales_channel,sales_channel),workflow_decision=null,malfunction_reported=true,malfunction_resolved_at=null,status=target where id=i.id;
 when 'compensation_complete','compensation_denied' then
  if not manager then raise exception '補填結果は管理側から登録してください' using errcode='42501';end if;
  if i.status<>'Amazon補填申請中' then raise exception 'Amazon補填申請中の商品ではありません';end if;
  target:='商品登録前';update app.items set sales_channel='ヤフオク',workflow_decision=case when p_action='compensation_complete' then 'compensated' else 'compensation_denied' end,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status=target where id=i.id;
 when 'listing_complete' then
  if i.status<>'商品登録前' or i.sales_channel not in ('FBA','自己発送') then raise exception 'FBA・自己発送の出品完了のみ手動で登録できます';end if;
  target:='出品中';update app.items set product_registered_at=clock_timestamp(),status=target where id=i.id;
 when 'listing_cancel' then
  if i.status<>'出品中' or nullif(btrim(p_note),'') is null then raise exception '実際に出品されていないことを確認してください';end if;
  target:='商品登録前';update app.items set product_registered_at=null,status=target,seller_cancelled_trade_key=coalesce(seller_trade_key,'*'),seller_cancelled_at=clock_timestamp() where id=i.id;
 when 'trade_cancel','resell' then
  if i.status<>'取引中' or nullif(btrim(p_note),'') is null then raise exception '取引中の商品について理由を入力してください';end if;
  target:=case when p_action='trade_cancel' then '出品中'::app.item_status else '商品登録前'::app.item_status end;
  update app.items set status=target,product_registered_at=case when p_action='resell' then null else product_registered_at end,seller_cancelled_trade_key=coalesce(seller_trade_key,'*'),seller_cancelled_at=clock_timestamp() where id=i.id;
 else raise exception '未対応の操作です' using errcode='22023';
 end case;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note) values(p_request_id,i.id,actor,p_action,i.status,target,nullif(btrim(p_note),''));
end $$;
revoke all on function app.perform_inventory_action(uuid,text,app.item_status,text,uuid) from public,anon;
grant execute on function app.perform_inventory_action(uuid,text,app.item_status,text,uuid) to authenticated;

-- Existing entry points share the same transition checks.
create or replace function app.report_item_malfunction(p_item_id uuid,p_comment text) returns void language plpgsql security invoker set search_path=pg_catalog,app as $$
begin perform app.perform_inventory_action(p_item_id,'report','検品中',p_comment);end $$;
create or replace function app.resolve_item_malfunction(p_item_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare state app.item_status;begin
 select status into state from app.items where id=p_item_id;
 perform app.perform_inventory_action(p_item_id,'send_back',state);
end $$;
-- Reuse existing supplier/Yahoo reply templates without moving or duplicating accessories.
create or replace function app.apply_malfunction_reply() returns trigger language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 if new.task_kind='仕入先確認' then update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  update app.items set workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前' where id=new.item_id;
 end if;return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;

-- Include small workflow flags in both full detail and incremental list reads.
do $$declare definition text;begin
 definition:=regexp_replace(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),';\s*$','');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as select v.*,i.return_request_completed_at,i.supplier_contact_requested_at,i.workflow_decision,i.seller_message_attention from ('||definition||') v join app.items i on i.id=v.id';
end $$;
notify pgrst,'reload schema';

-- Preserve conditional snapshots while exposing the current report phase to management.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'i.malfunction_reported_by,','i.malfunction_reported_by,i.status,');
 definition:=replace(definition,'where i.malfunction_reported and i.malfunction_resolved_at is null','where i.malfunction_reported and i.malfunction_resolved_at is null and i.status in (''動作不良'',''Amazon補填申請中'') and i.sold_on is null');
 execute definition;
end $$;
-- A delivery caller cannot bypass the flow through the previous general status API.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.set_inventory_workflow(uuid,app.item_status)'::regprocedure);
 definition:=replace(definition,'or i.deliverer_id=actor','');
 execute definition;
 definition:=pg_get_functiondef('app.sync_marketplace_sale_status(text,text,text,timestamptz)'::regprocedure);
 definition:=replace(definition,'if i.marketplace_status_observed_at is not null','if i.seller_cancelled_at is not null then return ''protected'';end if; if i.marketplace_status_observed_at is not null');
 execute definition;
end $$;
-- Seller records attach to an existing physical inventory row. A scrape never inserts inventory.
create table app.seller_listings(
 id uuid primary key default gen_random_uuid(),item_id uuid not null references app.items(id) on delete cascade,
 channel app.sales_channel not null check(channel in ('メルカリ','ヤフオク')),account_id text not null check(account_id in ('mercari-1','auctions-1')),
 external_id text not null,url text not null,trade_url text,trade_key text,observed_at timestamptz,active boolean not null default true,
 unique(channel,account_id,external_id)
);
create unique index seller_current_item on app.seller_listings(item_id) where active;
create table app.seller_operations(
 id uuid primary key,item_id uuid not null references app.items(id) on delete cascade,actor_id uuid not null references app.staff(id),
 kind text not null check(kind in ('listing','shipping_code','register_package','verify_shipping','ship_notice','message_sync','message_send')),
 channel app.sales_channel not null,account_id text not null,expected_status app.item_status not null,expected_updated_at timestamptz not null,payload jsonb not null,
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','uncertain')),
 result jsonb not null default '{}',created_at timestamptz not null default clock_timestamp(),claimed_at timestamptz,finished_at timestamptz
);
create unique index seller_one_pending on app.seller_operations(item_id) where status in ('queued','running','uncertain');
create index seller_queue on app.seller_operations(account_id,created_at) where status='queued';
alter table app.seller_listings enable row level security;
alter table app.seller_operations enable row level security;
revoke all on app.seller_listings,app.seller_operations from public,anon,authenticated;
grant select on app.seller_listings,app.seller_operations to authenticated;
create policy seller_listing_read on app.seller_listings for select to authenticated using(exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))));
create policy seller_operation_read on app.seller_operations for select to authenticated using(exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))));
create function app.seller_operation_context(p_item_id uuid) returns jsonb language sql stable security invoker set search_path=pg_catalog,app as $$
 select jsonb_build_object('listing',(select to_jsonb(l) from app.seller_listings l where l.item_id=i.id and l.active),'assignee',(select name from app.staff where id=i.deliverer_id),
 'revision',i.updated_at,'operations',coalesce((select jsonb_agg((to_jsonb(q)-'payload')||jsonb_build_object('trade_key',q.payload->>'trade_key','result',case when q.status='succeeded' and q.id=(select o.id from app.seller_operations o where o.item_id=i.id and o.kind=q.kind and o.status='succeeded' order by o.created_at desc limit 1) then q.result else jsonb_build_object('note',q.result->>'note') end) order by q.created_at desc) from (select * from app.seller_operations where item_id=i.id order by created_at desc limit 12) q),'[]'::jsonb)) from app.items i where i.id=p_item_id
$$;
revoke all on function app.seller_operation_context(uuid) from public,anon;
grant execute on function app.seller_operation_context(uuid) to authenticated;
create function app.queue_seller_operation(p_item_id uuid,p_kind text,p_payload jsonb,p_request_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;a uuid:=app.current_staff_id();existing app.seller_operations;link app.seller_listings;proof app.seller_operations;
begin
 if auth.uid() is null or a is null or not exists(select 1 from app.staff where id=a and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=a,false) then raise exception '納品担当者または管理者のみ操作できます' using errcode='42501';end if;
 select * into existing from app.seller_operations where id=p_request_id;
 if found then if existing.item_id=i.id and existing.actor_id=a and existing.kind=p_kind and existing.payload=p_payload then return existing.id;end if;raise exception '操作IDが重複しています';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から操作してください';end if;
 if i.sold_on is not null or i.status='販売済' then raise exception '販売済の商品は操作できません';end if;
 if i.sales_channel not in ('メルカリ','ヤフオク') or i.sales_channel is null then raise exception '販売先が対応していません';end if;
 if nullif(p_payload->>'expected_revision','')::timestamptz is distinct from i.updated_at then raise exception '商品が更新されています。内容を確認してから操作してください';end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>200000 then raise exception '入力内容を確認してください';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '前の操作の結果確認が必要です。二重実行を防ぐため停止しました';end if;
 select * into link from app.seller_listings where item_id=i.id and active;
 if p_kind='listing' then
  if i.status<>'商品登録前' then raise exception '商品登録前の商品だけ出品できます';end if;
  if length(btrim(coalesce(p_payload->>'title',''))) not between 1 and 128 or length(btrim(coalesce(p_payload->>'description',''))) not between 1 and 5000
  or coalesce(p_payload->>'price','')!~'^[0-9]{1,9}$' or (p_payload->>'price')::numeric<1
  or nullif(p_payload->>'condition','') is null or nullif(p_payload->>'origin','') is null or nullif(p_payload->>'shippingMethod','') is null
  or jsonb_typeof(p_payload->'photos') is distinct from 'array' then raise exception '出品内容を確認してください';end if;
  if jsonb_array_length(p_payload->'photos') not between 1 and 10 or exists(select 1 from jsonb_array_elements_text(p_payload->'photos') u where u!~'^https://(xgoppuqoqeppckyunnvx[.]supabase[.]co/|lh3[.]googleusercontent[.]com/|drive[.]google[.]com/|drive[.]usercontent[.]google[.]com/|drive[.]googleusercontent[.]com/)') then raise exception '商品写真を確認してください';end if;
 elsif p_kind in ('shipping_code','register_package','verify_shipping','ship_notice','message_sync','message_send') then
  if (i.status<>'取引中' and not (p_kind in ('message_sync','message_send') and i.status='出品中' and i.seller_message_attention)) or link.id is null or link.trade_key is null then raise exception '対象の取引情報を先に取得してください';end if;
  if p_payload->>'trade_key' is distinct from link.trade_key then raise exception '取引情報が更新されています';end if;
  if p_kind='register_package' and length(btrim(coalesce(p_payload->>'code',''))) not between 1 and 2048 then raise exception '専用資材のコードを読み取ってください';end if;
  if p_kind='message_send' and length(btrim(coalesce(p_payload->>'body',''))) not between 1 and 2000 then raise exception 'メッセージを入力してください';end if;
  if p_kind='ship_notice' then
   select * into proof from app.seller_operations where id=(p_payload->>'proof_id')::uuid and item_id=i.id and status='succeeded' and payload->>'trade_key'=link.trade_key;
   if proof.id is null or not ((proof.kind='register_package' and (p_payload->>'posted')::boolean is true) or (proof.kind='verify_shipping' and (proof.result->>'accepted')::boolean is true)) then raise exception 'コード登録後の投函、または店舗での受付を確認してください';end if;
  end if;
 else raise exception '未対応の操作です';end if;
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload)
 values(p_request_id,i.id,a,p_kind,i.sales_channel,case when i.sales_channel='メルカリ' then 'mercari-1' else 'auctions-1' end,i.status,i.updated_at,p_payload);
 return p_request_id;
end $$;
revoke all on function app.queue_seller_operation(uuid,text,jsonb,uuid) from public,anon;
grant execute on function app.queue_seller_operation(uuid,text,jsonb,uuid) to authenticated;
create function app.extension_seller_queue(p_account_ids text[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (select o.*,l.external_id,coalesce(l.trade_url,l.url) url,l.trade_key from app.seller_operations o left join app.seller_listings l on l.item_id=o.item_id and l.active where o.status='queued' and o.account_id=any(p_account_ids) order by o.created_at limit 10) q),'[]'::jsonb);
end $$;
create function app.extension_claim_seller_operation(p_id uuid,p_account_id text) returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 update app.seller_operations set status='running',claimed_at=clock_timestamp() where id=p_id and status='queued' and account_id=p_account_id and exists(select 1 from app.items i where i.id=app.seller_operations.item_id and i.status=app.seller_operations.expected_status and i.updated_at=app.seller_operations.expected_updated_at and i.sold_on is null and i.sales_channel=app.seller_operations.channel and (app.seller_operations.kind='listing' or exists(select 1 from app.seller_listings l where l.item_id=i.id and l.active and l.trade_key=app.seller_operations.payload->>'trade_key')));
 if found then return true;end if;
 update app.seller_operations set status='failed',finished_at=clock_timestamp(),result=jsonb_build_object('note','商品または取引が変更されたため実行しませんでした') where id=p_id and account_id=p_account_id and status='queued';return false;
end $$;
create function app.extension_finish_seller_operation(p_id uuid,p_status text,p_result jsonb) returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;ext text;u text;begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_status not in ('succeeded','failed','uncertain') or p_result is null or octet_length(p_result::text)>200000 then raise exception '結果を確認してください';end if;
 select * into q from app.seller_operations where id=p_id for update;
 if q.id is null then raise exception '操作がありません';end if;
 if q.status=p_status and q.result=p_result then return;end if;
 if q.status<>'running' then raise exception '実行済みの操作です';end if;
 select * into i from app.items where id=q.item_id for update;
 if p_status='succeeded' and q.kind='listing' then
  ext:=p_result->>'external_id';u:=p_result->>'url';
  if not ((q.channel='メルカリ' and ext~'^m[0-9]+$' and u='https://jp.mercari.com/item/'||ext) or (q.channel='ヤフオク' and ext~'^[a-z][0-9]+$' and u='https://page.auctions.yahoo.co.jp/jp/auction/'||ext)) then raise exception '出品結果のURL・商品IDを確認してください';end if;
  update app.seller_listings set active=false where item_id=i.id and active;
  insert into app.seller_listings(item_id,channel,account_id,external_id,url) values(i.id,q.channel,q.account_id,ext,u)
  on conflict(channel,account_id,external_id) do update set active=true where app.seller_listings.item_id=excluded.item_id;
  if not found then raise exception '他の商品と出品IDが重複しています';end if;
  if i.status=q.expected_status and i.sold_on is null and i.sales_channel=q.channel then
   update app.items set status='出品中',product_registered_at=clock_timestamp(),seller_trade_key=null,seller_cancelled_at=null,seller_cancelled_trade_key=null where id=i.id;
  else p_status:='uncertain';p_result:=p_result||jsonb_build_object('note','出品後に商品の状態が変わっています。出品URLを確認してください');end if;
 elsif p_status='succeeded' and q.kind='message_sync' then
  update app.items set seller_message_attention=coalesce((p_result->>'attention')::boolean,false) where id=i.id;
 end if;
 update app.seller_operations set status=p_status,result=p_result,finished_at=clock_timestamp() where id=q.id;
end $$;
revoke all on function app.extension_seller_queue(text[]),app.extension_claim_seller_operation(uuid,text),app.extension_finish_seller_operation(uuid,text,jsonb) from public,anon;
grant execute on function app.extension_seller_queue(text[]),app.extension_claim_seller_operation(uuid,text),app.extension_finish_seller_operation(uuid,text,jsonb) to authenticated;

-- Exact listing identity takes priority; legacy serial matching requires one exact row.
create function app.sync_seller_observation(p_account_id text,p_observation jsonb) returns text language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;l app.seller_listings;ch app.sales_channel;ext text:=p_observation->>'external_id';serial text:=lower(p_observation->>'serial');
 observed timestamptz:=(p_observation->>'observed_at')::timestamptz;state text:=p_observation->>'status';trade text:=p_observation->>'trade_key';n integer;day date;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case p_account_id when 'mercari-1' then 'メルカリ'::app.sales_channel when 'auctions-1' then 'ヤフオク'::app.sales_channel else null end;
 if nullif(p_observation->>'trade_url','') is not null and (p_observation->>'trade_url')!~'^https://(jp[.]mercari[.]com/transaction/|contact[.]auctions[.]yahoo[.]co[.]jp/|buy[.]auctions[.]yahoo[.]co[.]jp/|aucpay[.]yahoo[.]co[.]jp/|salesmanagement[.]yahoo[.]co[.]jp/)' then raise exception '取引URLを確認してください';end if;
 if ch is null or observed is null or observed>clock_timestamp()+interval '5 minutes' or observed<clock_timestamp()-interval '1 day' or state not in ('出品中','支払い待ち','取引中','販売済','キャンセル')
 or not ((ch='メルカリ' and ext~'^m[0-9]+$') or (ch='ヤフオク' and ext~'^[a-z][0-9]+$')) then raise exception '取得情報を確認してください';end if;
 select * into l from app.seller_listings where channel=ch and account_id=p_account_id and external_id=ext;
 if l.id is not null then
  if not l.active then return 'protected';end if;
  select * into i from app.items where id=l.item_id for update;
 else
  if serial is null or serial!~'^[0-9]+[a-z]*$' then return 'unmatched';end if;
  select count(*) into n from app.items where split_part(sku,'-',1)=serial and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq)) and sales_channel=ch;
  if n<>1 then return 'unmatched';end if;
  select * into i from app.items where split_part(sku,'-',1)=serial and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq)) and sales_channel=ch for update;
  if exists(select 1 from app.seller_listings where item_id=i.id and active) then return 'unmatched';end if;
  insert into app.seller_listings(item_id,channel,account_id,external_id,url) values(i.id,ch,p_account_id,ext,case when ch='メルカリ' then 'https://jp.mercari.com/item/'||ext else 'https://page.auctions.yahoo.co.jp/jp/auction/'||ext end) returning * into l;
 end if;
 if i.sold_on is not null or i.status in ('販売済','返品処理','動作不良','Amazon補填申請中') or i.sales_channel<>ch then return 'protected';end if;
 if greatest(l.observed_at,i.marketplace_status_observed_at)>=observed then return 'stale';end if;
 if i.seller_cancelled_at is not null and (i.seller_cancelled_trade_key='*' or trade is null or trade=i.seller_cancelled_trade_key or trade=ext or state not in ('取引中','販売済')) then return 'protected';end if;
 if state='販売済' then
  day:=(p_observation->>'sold_on')::date;
  if day is null or day>(clock_timestamp() at time zone 'Asia/Tokyo')::date or day<i.purchased_at or coalesce(p_observation->>'sold_price','')!~'^[0-9]{1,9}$' or coalesce(p_observation->>'payout_amount','')!~'^[0-9]{1,9}$' then raise exception '実際の販売日・販売金額・振込金額を確認できません';end if;
  if l.trade_key is not null and l.trade_key<>l.external_id and trade is distinct from l.trade_key then return 'unmatched';end if;
  update app.items set sold_on=day,sold_price=(p_observation->>'sold_price')::numeric,payout_amount=(p_observation->>'payout_amount')::numeric,status='販売済',seller_trade_key=trade,marketplace_status_observed_at=observed where id=i.id;
 elsif state='キャンセル' then
  if i.status<>'取引中' or trade is distinct from l.trade_key then return 'protected';end if;
  update app.items set status='出品中',seller_cancelled_trade_key=coalesce(trade,'*'),seller_cancelled_at=observed,marketplace_status_observed_at=observed where id=i.id;
 else
  if i.status not in ('商品登録前','出品中','取引中') then return 'protected';end if;
  if state in ('取引中','支払い待ち') and trade is null then raise exception '取引IDを確認してください';end if;
  if i.status='取引中' and state in ('出品中','支払い待ち') then return 'protected';end if;
  update app.items set status=case when state='支払い待ち' then '出品中'::app.item_status else state::app.item_status end,
   seller_trade_key=coalesce(trade,seller_trade_key),seller_cancelled_at=case when trade is not null and trade is distinct from seller_cancelled_trade_key then null else seller_cancelled_at end,marketplace_status_observed_at=observed,
   seller_message_attention=coalesce((p_observation->>'attention')::boolean,false) where id=i.id;
 end if;
 update app.seller_listings set observed_at=observed,trade_key=coalesce(trade,trade_key),trade_url=coalesce(p_observation->>'trade_url',trade_url) where id=l.id;
 return 'updated';
end $$;
revoke all on function app.sync_seller_observation(text,jsonb) from public,anon;
grant execute on function app.sync_seller_observation(text,jsonb) to authenticated;
notify pgrst,'reload schema';
-- All seven existing purchase/tracking accounts finish before seller reads begin.
create table app.seller_daily_barriers(day date not null,profile_id uuid not null,account_ids text[] not null,finished_at timestamptz not null default clock_timestamp(),primary key(day,profile_id));
alter table app.seller_daily_barriers enable row level security;
revoke all on app.seller_daily_barriers from public,anon,authenticated;
create function app.extension_seller_daily_barrier(p_day date,p_profile_id uuid,p_account_ids text[]) returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_day is distinct from (clock_timestamp() at time zone 'Asia/Tokyo')::date or p_profile_id is null or cardinality(p_account_ids) not between 1 and 7 or exists(select 1 from unnest(p_account_ids) a where a is null or a not in ('mercari-1','mercari-2','auctions-1','auctions-2','flea-1','flea-2','rakuma-1')) then raise exception '完了情報を確認してください';end if;
 insert into app.seller_daily_barriers(day,profile_id,account_ids) values(p_day,p_profile_id,p_account_ids) on conflict(day,profile_id) do update set account_ids=excluded.account_ids;
 delete from app.seller_daily_barriers where day<p_day-14;
 return (select count(distinct a)=7 from app.seller_daily_barriers b cross join lateral unnest(b.account_ids) a where b.day=p_day);
end $$;
create function app.seller_sync_context(p_account_ids text[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('item_id',i.id,'serial',split_part(i.sku,'-',1),'external_id',l.external_id,'account_id',case when i.sales_channel='メルカリ' then 'mercari-1' else 'auctions-1' end)) from app.items i left join app.seller_listings l on l.item_id=i.id and l.active where (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq)) and i.sold_on is null and i.status in ('商品登録前','出品中','取引中') and (case when i.sales_channel='メルカリ' then 'mercari-1' when i.sales_channel='ヤフオク' then 'auctions-1' end)=any(p_account_ids)),'[]'::jsonb);
end $$;
revoke all on function app.extension_seller_daily_barrier(date,uuid,text[]),app.seller_sync_context(text[]) from public,anon;
grant execute on function app.extension_seller_daily_barrier(date,uuid,text[]),app.seller_sync_context(text[]) to authenticated;
-- Supplier conversations remain available throughout the fault/return decision.
create table app.supplier_operations(
 id uuid primary key,item_id uuid not null references app.items(id) on delete cascade,actor_id uuid not null references app.staff(id),
 account_id text not null,marketplace text not null,external_id text not null,contact_requested_at timestamptz not null,kind text not null check(kind in ('read','send')),body text,
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','uncertain')),
 created_at timestamptz not null default clock_timestamp(),claimed_at timestamptz,finished_at timestamptz,note text
);
create unique index supplier_pending_item on app.supplier_operations(item_id) where status in ('queued','running','uncertain');
alter table app.supplier_operations enable row level security;
revoke all on app.supplier_operations from public,anon,authenticated;
create function app.supplier_conversation(p_item_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare i app.items;account text;begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()),false) then raise exception '権限がありません' using errcode='42501';end if;
 select case when count(distinct account_label)=1 then min(account_label) else null end into account from app.marketplace_purchase_drafts d where d.marketplace=i.marketplace::text and d.marketplace_item_id=i.marketplace_item_id;
 return jsonb_build_object('account_id',case account when 'メルカリ1' then 'mercari-1' when 'メルカリ2' then 'mercari-2' when 'ヤフオク1' then 'auctions-1' when 'ヤフオク2' then 'auctions-2' when 'Yahoo!フリマ1' then 'flea-1' when 'Yahoo!フリマ2' then 'flea-2' when 'ラクマ1' then 'rakuma-1' end,
 'messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.sent_at,m.synced_at) from (select id,author,author_role,body,sent_at,synced_at from app.marketplace_messages where item_id=i.id order by coalesce(sent_at,synced_at) desc limit 100) m),'[]'::jsonb),
 'outbox',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'body',q.body,'status',case q.status when 'running' then 'sending' when 'succeeded' then 'sent' else q.status end,'sent_at',q.finished_at,'result_note',q.note) order by q.created_at) from app.supplier_operations q where q.item_id=i.id and q.kind='send' and q.status<>'succeeded'),'[]'::jsonb),
 'sync',(select jsonb_build_object('id',q.id,'status',case q.status when 'succeeded' then 'completed' when 'running' then 'processing' else q.status end,'result_note',q.note) from app.supplier_operations q where q.item_id=i.id and q.kind='read' order by q.created_at desc limit 1),'expired',false);
end $$;
create function app.queue_supplier_operation(p_item_id uuid,p_kind text,p_body text,p_account_id text,p_request_id uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;q app.supplier_operations;a uuid:=app.current_staff_id();expected text;begin
 select * into i from app.items where id=p_item_id for update;
 if auth.uid() is null or a is null or not exists(select 1 from app.staff where id=a and is_active) or not coalesce(app.is_admin() or i.deliverer_id=a or (app.current_role()='purchaser' and i.purchaser_id=a),false) then raise exception '権限がありません' using errcode='42501';end if;
 if i.status<>'動作不良' or i.supplier_contact_requested_at is null or i.sold_on is not null then raise exception '仕入先確認が必要な動作不良商品から操作してください';end if;
 expected:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ' when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク' when p_account_id in ('flea-1','flea-2') then 'ヤフフリ' when p_account_id='rakuma-1' then 'ラクマ' end;
 if expected is null or not (i.marketplace::text=expected or (expected='ヤフフリ' and i.marketplace::text='PayPayフリマ')) or nullif(i.marketplace_item_id,'') is null then raise exception '購入したアカウントを選択してください';end if;
 select * into q from app.supplier_operations where id=p_request_id;
 if found then if q.item_id=i.id and q.actor_id=a and q.kind=p_kind and q.body is not distinct from p_body and q.account_id=p_account_id then return q.id;end if;raise exception '操作IDが重複しています';end if;
 if p_kind not in ('read','send') or p_request_id is null or (p_kind='send' and length(btrim(coalesce(p_body,''))) not between 1 and 2000) then raise exception '入力を確認してください';end if;
 if exists(select 1 from app.supplier_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '前の操作の結果を確認するまで再送できません';end if;
 insert into app.supplier_operations(id,item_id,actor_id,account_id,marketplace,external_id,contact_requested_at,kind,body) values(p_request_id,i.id,a,p_account_id,i.marketplace::text,i.marketplace_item_id,i.supplier_contact_requested_at,p_kind,p_body);return p_request_id;
end $$;
create function app.extension_supplier_queue(p_account_ids text[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (select o.* from app.supplier_operations o join app.items i on i.id=o.item_id where o.status='queued' and o.account_id=any(p_account_ids) and i.status='動作不良' and i.supplier_contact_requested_at is not null order by o.created_at limit 10) q),'[]'::jsonb);
end $$;
create function app.extension_claim_supplier_operation(p_id uuid,p_account_id text) returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
begin if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 update app.supplier_operations set status='running',claimed_at=clock_timestamp() where id=p_id and account_id=p_account_id and status='queued' and exists(select 1 from app.items i where i.id=app.supplier_operations.item_id and i.status='動作不良' and i.supplier_contact_requested_at=app.supplier_operations.contact_requested_at and i.sold_on is null and i.marketplace_item_id=app.supplier_operations.external_id);
 if found then return true;end if;update app.supplier_operations set status='failed',finished_at=clock_timestamp(),note='商品の状態が変更されたため実行しませんでした' where id=p_id and account_id=p_account_id and status='queued';return false;
end $$;
create function app.extension_finish_supplier_operation(p_id uuid,p_status text,p_messages jsonb,p_note text) returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.supplier_operations;begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 select * into q from app.supplier_operations where id=p_id for update;
 if q.id is null or q.status<>'running' or p_status not in ('succeeded','failed','uncertain') then raise exception '結果を確認してください';end if;
 if jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages)>500 or octet_length(p_messages::text)>2000000 then raise exception '会話の量を確認してください';end if;
 insert into app.marketplace_messages(marketplace,marketplace_item_id,item_id,external_id,author,author_role,body,sent_at)
 select q.marketplace,q.external_id,q.item_id,left(m->>'external_id',200),left(m->>'author',200),case when m->>'author_role' in ('self','other') then m->>'author_role' else 'unknown' end,left(m->>'body',10000),nullif(m->>'sent_at','')::timestamptz from jsonb_array_elements(p_messages) m where nullif(m->>'external_id','') is not null and nullif(m->>'body','') is not null
 on conflict(marketplace,marketplace_item_id,external_id) do update set body=excluded.body,author=excluded.author,sent_at=excluded.sent_at,synced_at=clock_timestamp();
 update app.supplier_operations set status=p_status,finished_at=clock_timestamp(),note=left(p_note,500) where id=q.id;
end $$;
revoke all on function app.supplier_conversation(uuid),app.queue_supplier_operation(uuid,text,text,text,uuid),app.extension_supplier_queue(text[]),app.extension_claim_supplier_operation(uuid,text),app.extension_finish_supplier_operation(uuid,text,jsonb,text) from public,anon;
grant execute on function app.supplier_conversation(uuid),app.queue_supplier_operation(uuid,text,text,text,uuid),app.extension_supplier_queue(text[]),app.extension_claim_supplier_operation(uuid,text),app.extension_finish_supplier_operation(uuid,text,jsonb,text) to authenticated;
create function app.read_supplier_operation(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare q app.supplier_operations;i app.items;begin
 select * into q from app.supplier_operations where id=p_id;select * into i from app.items where id=q.item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()),false) then raise exception '権限がありません' using errcode='42501';end if;
 return jsonb_build_object('status',q.status,'note',q.note);
end $$;
revoke all on function app.read_supplier_operation(uuid) from public,anon;
grant execute on function app.read_supplier_operation(uuid) to authenticated;

-- Conversation cleanup must not remove an active supplier-return discussion.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.purge_expired_marketplace_messages()'::regprocedure);
 definition:=replace(definition,'i.packed_completed_at is not null','i.status not in (''動作不良'',''Amazon補填申請中'',''取引中'') and i.packed_completed_at is not null');
 execute definition;
end $$;
create function app.read_seller_operation(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;begin
 select * into q from app.seller_operations where id=p_id;select * into i from app.items where id=q.item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()),false) then raise exception '権限がありません' using errcode='42501';end if;
 return jsonb_build_object('status',q.status,'note',q.result->>'note');
end $$;
revoke all on function app.read_seller_operation(uuid) from public,anon;
grant execute on function app.read_seller_operation(uuid) to authenticated;

create index seller_operations_item_time on app.seller_operations(item_id,created_at desc);
create index supplier_operations_item_time on app.supplier_operations(item_id,created_at desc);
create index supplier_messages_item_time on app.marketplace_messages(item_id,(coalesce(sent_at,synced_at)) desc);
notify pgrst,'reload schema';


-- ▼▼▼ 20261016105124_fix_explicit_accessory_parent_count.sql ▼▼▼

-- Preserve explicit parent links when registering an Amazon-return spare with a new body.
create or replace function app.enforce_amazon_return_main_item()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
  parent_id uuid;
  parent_count integer := 0;
  numeric_serial text;
  separator_and_tail text;
  parent_serial text;
  existing_depth integer;
  requested_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then return new; end if;

  if tg_op <> 'INSERT' then
    if new.amazon_returned_on is not null then new.is_accessory := false; end if;
    return new;
  end if;

  if new.is_accessory and new.work_stream::text = '付属品'
     and auth.uid() is not null and app.current_role() in ('admin','purchaser') then
    -- Resolve by the strongest available identity first. Numeric lot alone is used
    -- only when it identifies exactly one main item.
    if new.parent_item_id is not null then
      select p.id into parent_id from app.items p
       where p.id = new.parent_item_id and not p.is_accessory and p.lot_seq = new.lot_seq;
      if parent_id is null then
        raise exception '指定した本体が見つかりません。通番号を確認してください' using errcode='22023';
      end if;
      -- An explicit, validated parent is already exactly one match.
      parent_count := 1;
    end if;
    if parent_id is null and new.product_id is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.product_id = new.product_id;
    end if;
    if parent_id is null and nullif(new.marketplace_item_id,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_item_id = new.marketplace_item_id;
    end if;
    if parent_id is null and nullif(new.marketplace_url,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_url = new.marketplace_url;
    end if;
    if parent_id is null and nullif(new.asin,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.asin = new.asin and p.title = new.title;
    end if;
    if parent_id is null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p
       where not p.is_accessory and p.lot_seq = new.lot_seq;
    end if;
    if parent_count <> 1 or parent_id is null then
      raise exception '同じ通番号の本体を一意に特定できません。商品ID・ASIN・仕入先URLを確認してください' using errcode='22023';
    end if;
    select * into parent from app.items p where p.id = parent_id for update;
    new.parent_item_id := parent.id;
    new.marketplace_item_id := coalesce(new.marketplace_item_id, parent.marketplace_item_id);
    new.marketplace_url := coalesce(new.marketplace_url, parent.marketplace_url);
    new.product_id := coalesce(new.product_id, parent.product_id);
    new.asin := coalesce(new.asin, parent.asin);
    parent_serial := app.product_serial(parent.sku, parent.lot_seq);
  else
    new.is_accessory := false;
  end if;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if parent_serial is null then parent_serial := numeric_serial; end if;
  if separator_and_tail is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended('amazon-return:'||new.lot_seq::text||':'||coalesce(parent_serial,numeric_serial),179049));

  select coalesce(max(
      case when app.product_serial(i.sku,i.lot_seq) like parent_serial || '%'
           then length(app.product_serial(i.sku,i.lot_seq))-length(parent_serial) else 0 end
    ),0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and i.id <> coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid);

  requested_depth := length(coalesce((regexp_match(new.sku,'^[0-9]+([a-z]*)[-_]'))[1],''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  if new.is_accessory and parent_id is not null then
    new.sku := parent_serial || repeat('a', next_depth) || separator_and_tail;
  else
    new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  end if;
  return new;
end;
$$;


-- ▼▼▼ 20261016105523_avoid_parent_image_for_accessory.sql ▼▼▼

-- Shared workflow/sales identity does not make a main item's image an accessory image.
-- Keep each view's columns, grants, RLS/security options and unrelated calculations intact.
do $migration$
declare target record; definition text; original text; replacement text; row_alias text;
begin
 for target in select * from (values
  ('v_inventory_display','product','raw'),
  ('v_delivery_tasks','p','i_1')
 ) as t(view_name,product_alias,item_alias)
 loop
  definition:=pg_get_viewdef(format('app.%I',target.view_name)::regclass,true);
  row_alias:=target.item_alias;
  if target.view_name='v_delivery_tasks' and position('i_1.product_id' in definition)=0 then row_alias:='i';end if;
  original:=format('COALESCE(NULLIF(btrim(%s.image_url), ''''::text), NULLIF(btrim(asin_product.image_url), ''''::text))',target.product_alias);
  replacement:=format($image$
   COALESCE(
    CASE WHEN NOT EXISTS (
     SELECT 1 FROM app.items image_parent
     WHERE %1$s.is_accessory AND image_parent.id=%1$s.parent_item_id
       AND image_parent.product_id=%1$s.product_id
    ) THEN NULLIF(btrim(%2$s.image_url), '') END,
    CASE WHEN NOT EXISTS (
     SELECT 1 FROM app.items image_parent
     WHERE %1$s.is_accessory AND image_parent.id=%1$s.parent_item_id
       AND image_parent.asin=%1$s.asin
    ) THEN NULLIF(btrim(asin_product.image_url), '') END
   )
  $image$,row_alias,target.product_alias);
  if position(original in definition)=0 then raise exception 'Expected image expression changed in %',target.view_name;end if;
  execute format('CREATE OR REPLACE VIEW app.%I AS %s',target.view_name,replace(definition,original,replacement));
 end loop;
end $migration$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261016130000_seller_shipping_preferences.sql ▼▼▼

-- Keep reviewed listing/shipping choices when the operator opens the panel again.
-- Invoker security and all existing row policies remain in force.
create index if not exists seller_history_by_item on app.seller_operations(item_id,created_at desc);
create or replace function app.seller_operation_context(p_item_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog,app as $$
 select jsonb_build_object(
 'listing',(select to_jsonb(l) from app.seller_listings l where l.item_id=i.id and l.active),
 'assignee',(select name from app.staff where id=i.deliverer_id),
 'shipping_defaults',(
   select jsonb_strip_nulls(jsonb_build_object('shippingMethod',s.p->'shippingMethod','size',s.p->'size','weightKg',s.p->'weightKg','dropoff',s.p->'dropoff','category',s.p->'category'))
   from app.seller_listings l cross join lateral (
     select coalesce((select o.payload from app.seller_operations o where o.item_id=i.id and o.channel=l.channel and o.account_id=l.account_id and o.kind='listing' and o.status='succeeded' and o.result->>'external_id'=l.external_id order by o.created_at desc limit 1),'{}'::jsonb)
       || coalesce((select o.payload from app.seller_operations o where o.item_id=i.id and o.channel=l.channel and o.account_id=l.account_id and o.kind in ('shipping_code','register_package') and o.status='succeeded' and o.payload->>'trade_key'=l.trade_key order by o.created_at desc limit 1),'{}'::jsonb) p
   ) s where l.item_id=i.id and l.active
 ),
 'revision',i.updated_at,
 'operations',coalesce((select jsonb_agg((to_jsonb(q)-'payload')||jsonb_build_object('trade_key',q.payload->>'trade_key','result',case when q.status='succeeded' and q.id=(select o.id from app.seller_operations o where o.item_id=i.id and o.kind=q.kind and o.status='succeeded' order by o.created_at desc limit 1) then q.result else jsonb_build_object('note',q.result->>'note') end) order by q.created_at desc) from (select * from app.seller_operations where item_id=i.id order by created_at desc limit 12) q),'[]'::jsonb))
 from app.items i where i.id=p_item_id
$$;


-- ▼▼▼ 20261016131500_reuse_seller_history_index.sql ▼▼▼

-- The original seller migration already provides the same per-item history index.
-- Remove only the redundant index introduced by the shipping preferences migration.
drop index if exists app.seller_history_by_item;


-- ▼▼▼ 20261016161301_use_mercari_two_for_seller_operations.sql ▼▼▼

-- Keep purchase/tracking identities unchanged; only the seller account changes.
do $$declare signature text;definition text;begin
 perform set_config('lock_timeout','5s',true);
 lock table app.seller_listings, app.seller_operations in share row exclusive mode;
 if exists(select 1 from app.seller_listings where account_id='mercari-1' and active)
 or exists(select 1 from app.seller_operations where account_id='mercari-1' and status in ('queued','running','uncertain')) then
  raise exception 'メルカリ1の未完了操作・出品の紐付けを確認してから連携先を変更してください';
 end if;
-- Retain the old account value for historical records; new requests use account 2.
alter table app.seller_listings drop constraint seller_listings_account_id_check;
alter table app.seller_listings add constraint seller_listings_account_id_check
 check(account_id in ('mercari-1','mercari-2','auctions-1'));
 foreach signature in array array[
  'app.queue_seller_operation(uuid,text,jsonb,uuid)',
  'app.sync_seller_observation(text,jsonb)',
  'app.seller_sync_context(text[])'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if strpos(definition,'''mercari-1''')=0 then raise exception 'Expected seller account mapping was not found: %',signature;end if;
  execute replace(definition,'''mercari-1''','''mercari-2''');
 end loop;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261016195039_sync_spare_shipping_recipient.sql ▼▼▼

-- Keep the source holder fixed; only pending destinations follow inventory.
-- A pending allocation may temporarily need no shipment (same holder/no assignee).
alter table app.spare_shipping_tasks
  add column delivery_required boolean not null default true;
alter table app.spare_shipping_tasks drop constraint spare_shipping_tasks_check;
alter table app.spare_shipping_tasks add constraint spare_shipping_distinct_or_suspended
  check(owner_staff_id<>recipient_staff_id or (sent_at is null and not delivery_required));

create function app.sync_spare_shipping_recipient()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.deliverer_id is not distinct from old.deliverer_id then
    return new;
  end if;
  update app.spare_shipping_tasks t
  set recipient_staff_id=case
        when new.deliverer_id is not null
        then new.deliverer_id else t.recipient_staff_id end,
      delivery_required=(s.owner_staff_id is not null and new.deliverer_id is not null and new.deliverer_id<>t.owner_staff_id)
  from app.spare_accessories s
  where t.spare_id=s.id and t.item_id=new.id and t.sent_at is null and t.completed_at is null;
  return new;
end $$;
revoke all on function app.sync_spare_shipping_recipient() from public,anon,authenticated;

create trigger items_sync_spare_shipping_recipient
after update of deliverer_id on app.items
for each row execute function app.sync_spare_shipping_recipient();

-- Inline name edits previously left the holder's foreign key unchanged.
-- An explicit ID change wins; a unique registered name edit resolves that ID.
create function app.sync_spare_holder_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
declare matches uuid[]; label text;
begin
  if tg_op='UPDATE' then
    if new.owner_staff_id is distinct from old.owner_staff_id then
      select s.name into label from app.staff s where s.id=new.owner_staff_id;
      new.owner_name:=label;
      return new;
    end if;
    if new.owner_name is not distinct from old.owner_name then return new;end if;
  end if;
  select array_agg(s.id) into matches from app.staff s
  where s.is_active and regexp_replace(s.name,'[[:space:]　]','','g')=
    regexp_replace(regexp_replace(coalesce(new.owner_name,''),'[[:space:]　]','','g'),'^[A-Za-z]{2}','');
  if cardinality(matches)=1 then
    new.owner_staff_id:=matches[1];
    select s.name into new.owner_name from app.staff s where s.id=matches[1];
  end if;
  return new;
end $$;
revoke all on function app.sync_spare_holder_identity() from public,anon,authenticated;
create trigger spare_sync_holder_identity
before insert or update of owner_name,owner_staff_id on app.spare_accessories
for each row execute function app.sync_spare_holder_identity();

create function app.sync_spare_shipping_holder()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.owner_staff_id is not distinct from old.owner_staff_id then return new;end if;
  update app.spare_shipping_tasks t
  set owner_staff_id=coalesce(new.owner_staff_id,t.owner_staff_id),
      recipient_staff_id=coalesce(i.deliverer_id,t.recipient_staff_id),
      delivery_required=(new.owner_staff_id is not null and i.deliverer_id is not null and new.owner_staff_id<>i.deliverer_id)
  from app.items i
  where t.spare_id=new.id and i.id=t.item_id and t.sent_at is null and t.completed_at is null;
  return new;
end $$;
revoke all on function app.sync_spare_shipping_holder() from public,anon,authenticated;
create trigger spare_sync_shipping_holder
after update on app.spare_accessories
for each row execute function app.sync_spare_shipping_holder();

-- Repair uniquely named holders, including legacy allocations without a task.
-- The shipping trigger still leaves dispatched/completed history intact.
update app.spare_accessories s
set owner_staff_id=staff.id
from app.staff staff
where staff.is_active and s.owner_staff_id is distinct from staff.id
  and regexp_replace(staff.name,'[[:space:]　]','','g')=
      regexp_replace(regexp_replace(coalesce(s.owner_name,''),'[[:space:]　]','','g'),'^[A-Za-z]{2}','')
  and (select count(*) from app.staff other where other.is_active and
       regexp_replace(other.name,'[[:space:]　]','','g')=regexp_replace(staff.name,'[[:space:]　]','','g'))=1
  ;

-- Repair existing pending allocations, without changing sent/completed history.
update app.spare_shipping_tasks t
set recipient_staff_id=case
      when i.deliverer_id is not null
      then i.deliverer_id else t.recipient_staff_id end,
    delivery_required=(s.owner_staff_id is not null and i.deliverer_id is not null and i.deliverer_id<>t.owner_staff_id)
from app.items i, app.spare_accessories s
where i.id=t.item_id and s.id=t.spare_id and t.sent_at is null and t.completed_at is null
  and (t.recipient_staff_id is distinct from i.deliverer_id
       or t.delivery_required is distinct from (s.owner_staff_id is not null and i.deliverer_id is not null and i.deliverer_id<>t.owner_staff_id));

-- Preserve the existing view columns and RLS. No join to items here: a holder
-- must still see shipping requests even when they cannot read the target item.
create or replace view app.v_spare_shipping_tasks with (security_invoker=true) as
select t.id,t.spare_id,t.item_id,t.accessory_item_id,t.owner_staff_id,t.recipient_staff_id,
       t.title,t.manufacturer,t.marketplace,t.marketplace_item_id,t.usage_note,t.lot_seq,
       t.tracking_no,t.created_at,t.sent_at,t.completed_at,
       o.code owner_code,o.name owner_name,d.code recipient_code,d.name recipient_name
from app.spare_shipping_tasks t join app.staff o on o.id=t.owner_staff_id
join app.staff d on d.id=t.recipient_staff_id
where t.delivery_required or t.sent_at is not null;

-- Avoid updating the accessory twice while its BEFORE trigger redirects to the body.
create or replace function app.redirect_accessory_shared_edits()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype; previous_redirect text;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory
     or app.is_standalone_accessory_serial(old.sku,old.lot_seq) then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  select p.* into parent from app.items p
  where not p.is_accessory and (
    p.id = coalesce(new.parent_item_id, old.parent_item_id)
    or (new.parent_item_id is null and old.parent_item_id is null
        and p.lot_seq = old.lot_seq
        and app.product_serial(p.sku,p.lot_seq) = app.product_serial(old.sku,old.lot_seq))
  )
  order by (p.id = coalesce(new.parent_item_id, old.parent_item_id)) desc
  limit 1
  for update;

  if parent.id is null then
    raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください' using errcode='22023';
  end if;

  previous_redirect:=current_setting('app.redirecting_accessory_id',true);
  perform set_config('app.redirecting_accessory_id',old.id::text,true);
  update app.items set
    status = new.status,
    packed_on = new.packed_on,
    shipped_on = new.shipped_on,
    returned_on = new.returned_on,
    sales_channel = new.sales_channel,
    condition = new.condition,
    sold_on = new.sold_on,
    sold_price = new.sold_price,
    payout_amount = new.payout_amount,
    lot_seq = new.lot_seq,
    deliverer_id = new.deliverer_id,
    sku = parent.sku
  where id = parent.id;

  perform set_config('app.redirecting_accessory_id',coalesce(previous_redirect,''),true);
  select * into parent from app.items where id = parent.id;
  new.parent_item_id := parent.id;
  new.status := parent.status;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.returned_on := parent.returned_on;
  new.sales_channel := parent.sales_channel;
  new.condition := parent.condition;
  new.sold_on := parent.sold_on;
  new.sold_price := parent.sold_price;
  new.payout_amount := parent.payout_amount;
  new.lot_seq := parent.lot_seq;
  new.deliverer_id := parent.deliverer_id;
  new.sku := app.accessory_sku_for_parent(parent.sku, old.sku);
  return new;
end;
$$;


create or replace function app.sync_accessory_sale_date()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  accessory app.items%rowtype;
begin
  if new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  for accessory in
    select a.* from app.items a
    where a.id::text is distinct from nullif(current_setting('app.redirecting_accessory_id',true),'')
      and a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and (
      a.parent_item_id = new.id
      or (a.parent_item_id is null and a.lot_seq = old.lot_seq
          and app.product_serial(a.sku,a.lot_seq) = app.product_serial(old.sku,old.lot_seq))
    )
    for update
  loop
    update app.items set
      parent_item_id = new.id,
      status = new.status,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      returned_on = new.returned_on,
      sales_channel = new.sales_channel,
      condition = new.condition,
      sold_on = new.sold_on,
      sold_price = new.sold_price,
      payout_amount = new.payout_amount,
      sku = app.accessory_sku_for_parent(new.sku, accessory.sku),
      lot_seq = new.lot_seq,
      deliverer_id = new.deliverer_id
    where id = accessory.id;
  end loop;
  return new;
end;
$$;


-- ▼▼▼ 20261017021118_packing_photos.sql ▼▼▼

alter table app.item_photos add column photo_kind text not null default 'product'
  check(photo_kind in ('product','packing'));

-- Packing evidence must not reopen product-photo approval or change progress.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('app.invalidate_photo_review()'::regprocedure);
 definition:=replace(definition,'begin','begin' || chr(10) || '  if new.photo_kind=''packing'' then return new;end if;');
 execute definition;
 definition:=pg_get_functiondef('app.handle_deleted_item_photo()'::regprocedure);
 definition:=replace(definition,'begin','begin' || chr(10) || '  if old.photo_kind=''packing'' then return old;end if;');
 definition:=replace(definition,'where item_id = old.item_id;','where item_id = old.item_id and photo_kind=''product'';');
 -- Only item_photos has photo_kind; leave the photo_reviews DELETE unchanged.
 definition:=replace(definition,'delete from app.photo_reviews where item_id = old.item_id and photo_kind=''product'';','delete from app.photo_reviews where item_id = old.item_id;');
 execute definition;
 definition:=pg_get_functiondef('app.approve_photo_review(uuid)'::regprocedure);
 definition:=replace(definition,'from app.item_photos where item_id = p_item_id;','from app.item_photos where item_id = p_item_id and photo_kind=''product'';');
 execute definition;
end $$;

create function app.validate_packing_photo_stage() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item app.items;begin
 if new.photo_kind<>'packing' then return new;end if;
 select * into item from app.items where id=new.item_id;
 if item.id is null or not coalesce(case when item.sales_channel='FBA' then item.status='商品登録前'
   else item.sales_channel in ('自己発送','メルカリ','ヤフオク') and item.status='出品中' end,false) then
   raise exception '現在の販売状態では梱包写真を追加できません' using errcode='22023';
 end if;
 return new;
end $$;
revoke all on function app.validate_packing_photo_stage() from public,anon,authenticated;
create trigger item_photos_validate_packing before insert on app.item_photos
for each row execute function app.validate_packing_photo_stage();
notify pgrst,'reload schema';


-- ▼▼▼ 20261017032440_four_account_sale_reconciliation.sql ▼▼▼

-- Read four sale accounts; keep listing publication defaults separate.
alter table app.seller_listings drop constraint seller_listings_account_id_check;
alter table app.seller_listings add constraint seller_listings_account_id_check
 check (account_id in ('mercari-1','mercari-2','auctions-1','auctions-2'));
alter table app.seller_listings add column verified_sale jsonb;
alter table app.seller_listings add column observed_status text;

-- Identity is independent of the currently selected sales channel.
-- Suffixes remain exact: 123, 123a and 123b are distinct inventory rows.
create function app.resolve_seller_observation_item(p_account_id text,p_row jsonb)
returns uuid language plpgsql stable set search_path=pg_catalog,app as $$
declare target uuid; n integer; serial text:=lower(p_row->>'serial');
begin
 select item_id into target from app.seller_listings
 where account_id=p_account_id and external_id=p_row->>'external_id';
 if found then return target;end if;
 if serial is null or serial!~'^[0-9]+[a-z]*$' or length(serial)>40 then return null;end if;
 select count(*),min(id::text)::uuid into n,target from app.items
 where app.product_serial(sku,lot_seq)=serial
 and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq));
 return case when n=1 then target else null end;
end $$;
revoke all on function app.resolve_seller_observation_item(text,jsonb) from public,anon,authenticated;

-- Only verified, unchanged sale values count toward Mercari's five in a row.
create function app.seller_observation_plan(p_account_id text,p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare row jsonb; i app.items; l app.seller_listings; ch app.sales_channel; action text; result jsonb:='[]';
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ'::app.sales_channel when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク'::app.sales_channel end;
 if ch is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>2000 or octet_length(p_rows::text)>1000000 then raise exception '取得情報を確認してください';end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  select * into i from app.items where id=app.resolve_seller_observation_item(p_account_id,row);
  select * into l from app.seller_listings where account_id=p_account_id and external_id=row->>'external_id';
  if i.id is null then action:='unmatched';
  elsif row->>'status'='販売済' then
   if i.status='販売済' and i.sales_channel=ch and i.sold_on is not null and i.sold_price is not null and i.payout_amount is not null
    and l.observed_status='販売済'
    and l.verified_sale=jsonb_build_object('sold_on',i.sold_on,'sold_price',i.sold_price,'payout_amount',i.payout_amount) then action:='registered';
   else action:='detail';end if;
  elsif i.sold_on is not null or i.status in ('販売済','返品処理','動作不良','Amazon補填申請中') then action:='protected';
  elsif l.active and l.observed_status=row->>'status' and i.sales_channel=ch
   and i.status::text=(case when row->>'status'='支払い待ち' then '出品中' else row->>'status' end)
   and i.seller_message_attention=coalesce((row->>'attention')::boolean,false) then action:='unchanged';
  elsif row->>'status' in ('取引中','キャンセル') then action:='detail';
  else action:='apply';end if;
  result:=result||jsonb_build_array(jsonb_build_object('external_id',row->>'external_id','action',action));
 end loop;
 return result;
end $$;
revoke all on function app.seller_observation_plan(text,jsonb) from public,anon;
grant execute on function app.seller_observation_plan(text,jsonb) to authenticated;

create or replace function app.sync_seller_observation(p_account_id text,p_observation jsonb)
returns text language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items; l app.seller_listings; ch app.sales_channel; ext text:=p_observation->>'external_id'; target uuid;
 observed timestamptz:=(p_observation->>'observed_at')::timestamptz; state text:=p_observation->>'status';
 trade text:=p_observation->>'trade_key'; day date; price numeric; payout numeric; proof jsonb;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ'::app.sales_channel when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク'::app.sales_channel end;
 if ch is null or observed is null or observed>clock_timestamp()+interval '5 minutes' or observed<clock_timestamp()-interval '1 day'
 or state not in ('出品中','支払い待ち','取引中','販売済','キャンセル') or state is null
 or not ((ch='メルカリ' and ext~'^m[0-9]+$') or (ch='ヤフオク' and ext~'^[a-z][0-9]+$')) or ext is null then raise exception '取得情報を確認してください';end if;
 if nullif(p_observation->>'trade_url','') is not null and (p_observation->>'trade_url')!~'^https://(jp[.]mercari[.]com/transaction/|contact[.]auctions[.]yahoo[.]co[.]jp/|buy[.]auctions[.]yahoo[.]co[.]jp/|aucpay[.]yahoo[.]co[.]jp/|salesmanagement[.]yahoo[.]co[.]jp/)' then raise exception '取引URLを確認してください';end if;
 target:=app.resolve_seller_observation_item(p_account_id,p_observation);
 if target is null then return 'unmatched';end if;
 perform pg_advisory_xact_lock(hashtextextended(target::text,179050));
 select * into i from app.items where id=target for update;
 select * into l from app.seller_listings where account_id=p_account_id and external_id=ext for update;
 if l.id is not null and l.item_id<>i.id then return 'unmatched';end if;
 if i.status in ('返品処理','動作不良','Amazon補填申請中') and i.sold_on is null then return 'protected';end if;
 if greatest(l.observed_at,i.marketplace_status_observed_at)>=observed then return 'stale';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) then return 'protected';end if;
 if state='販売済' then
  day:=(p_observation->>'sold_on')::date;
  if day is null or day>(clock_timestamp() at time zone 'Asia/Tokyo')::date or day<i.purchased_at
   or coalesce(p_observation->>'sold_price','')!~'^[0-9]{1,9}$' or coalesce(p_observation->>'payout_amount','')!~'^[0-9]{1,9}$'
   then raise exception '実際の販売日・販売金額・振込金額を確認できません';end if;
  price:=(p_observation->>'sold_price')::numeric;payout:=(p_observation->>'payout_amount')::numeric;
  if i.sold_on is not null and (i.sold_on<>day or (i.sold_price is not null and i.sold_price<>price)
   or (i.payout_amount is not null and i.payout_amount<>payout)) then return 'conflict';end if;
  if l.trade_key is not null and l.trade_key<>l.external_id and trade is distinct from l.trade_key then return 'unmatched';end if;
  proof:=jsonb_build_object('sold_on',day,'sold_price',price,'payout_amount',payout);
 else
  if i.sold_on is not null or i.status='販売済' then return 'protected';end if;
  if i.seller_cancelled_at is not null and (i.seller_cancelled_trade_key='*' or trade is null or trade=i.seller_cancelled_trade_key or trade=ext or state<>'取引中') then return 'protected';end if;
  if state='キャンセル' and (i.status<>'取引中' or trade is distinct from l.trade_key or l.id is null) then return 'protected';end if;
  if state<>'キャンセル' and i.status not in ('商品登録前','出品中','取引中') then return 'protected';end if;
  if state in ('取引中','支払い待ち') and trade is null then raise exception '取引IDを確認してください';end if;
  if i.status='取引中' and state in ('出品中','支払い待ち') then return 'protected';end if;
  -- Only confirmed purchases/sales can correct a forgotten channel.
  if i.sales_channel is distinct from ch and state<>'取引中' then return 'protected';end if;
 end if;
 -- One inventory item, one active listing; preserve older links as history.
 if state in ('取引中','販売済') then
  update app.seller_listings set active=false where item_id=i.id and active and id is distinct from l.id;
 elsif l.id is not null and not l.active then return 'protected';
 elsif exists(select 1 from app.seller_listings where item_id=i.id and active and id is distinct from l.id) then return 'unmatched';end if;
 if l.id is null then
  insert into app.seller_listings(item_id,channel,account_id,external_id,url)
  values(i.id,ch,p_account_id,ext,case when ch='メルカリ' then 'https://jp.mercari.com/item/'||ext else 'https://page.auctions.yahoo.co.jp/jp/auction/'||ext end) returning * into l;
 end if;
 if state='販売済' then
  update app.items set sales_channel=ch,sold_on=day,sold_price=price,payout_amount=payout,status='販売済',
   seller_trade_key=trade,marketplace_status_observed_at=observed where id=i.id;
 elsif state='キャンセル' then
  update app.items set status='出品中',seller_cancelled_trade_key=coalesce(trade,'*'),seller_cancelled_at=observed,marketplace_status_observed_at=observed where id=i.id;
 else
  update app.items set sales_channel=case when state='取引中' then ch else sales_channel end,
   status=case when state='支払い待ち' then '出品中'::app.item_status else state::app.item_status end,
   seller_trade_key=coalesce(trade,seller_trade_key),seller_cancelled_at=case when trade is not null and trade is distinct from seller_cancelled_trade_key then null else seller_cancelled_at end,
   marketplace_status_observed_at=observed,seller_message_attention=coalesce((p_observation->>'attention')::boolean,false) where id=i.id;
 end if;
 update app.seller_listings set active=true,observed_at=observed,observed_status=state,verified_sale=proof,
 trade_key=coalesce(trade,trade_key),trade_url=coalesce(p_observation->>'trade_url',trade_url) where id=l.id;
 return case when state='販売済' then 'registered' else 'updated' end;
end $$;
revoke all on function app.sync_seller_observation(text,jsonb) from public,anon;
grant execute on function app.sync_seller_observation(text,jsonb) to authenticated;

-- Existing shipping/message actions follow the linked account, not the publication default.
do $$declare d text;begin
 d:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 d:=replace(d,'case when i.sales_channel=''メルカリ'' then ''mercari-2'' else ''auctions-1'' end',
 'case when p_kind<>''listing'' and link.id is not null then link.account_id when i.sales_channel=''メルカリ'' then ''mercari-2'' else ''auctions-1'' end');
 execute d;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261017034907_normalize_seller_serial_case.sql ▼▼▼

-- app.product_serial intentionally returns suffixes in upper case for accounting.
-- Marketplace parsers use lower case. Normalize both while preserving the whole suffix.
do $$declare d text;begin
 d:=pg_get_functiondef('app.resolve_seller_observation_item(text,jsonb)'::regprocedure);
 if strpos(d,'app.product_serial(sku,lot_seq)=serial')=0 then raise exception 'Expected serial comparison not found';end if;
 execute replace(d,'app.product_serial(sku,lot_seq)=serial','lower(app.product_serial(sku,lot_seq))=serial');
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261017090000_require_listing_photo_approval.sql ▼▼▼

-- Approval is mandatory for listing, independent of the legacy packing gate.
create function app.listing_photos_approved(p_item_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from app.photo_reviews r where r.item_id=p_item_id
  and r.approved_at is not null and r.exported_photo_count=(
   select count(*) from app.item_photos p where p.item_id=p_item_id and p.photo_kind='product'));
$$;
revoke all on function app.listing_photos_approved(uuid) from public,anon;
grant execute on function app.listing_photos_approved(uuid) to authenticated,service_role;

-- Append to the existing invoker view so page revisions also change on approval.
do $$ declare definition text; patched text; begin
 definition:=rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),E';\n ');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as select v.*,app.listing_photos_approved(v.id) as photo_review_approved from ('||definition||') v';

 definition:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
 patched:=replace(definition,'when ''listing_complete'' then','when ''listing_complete'' then
  if not app.listing_photos_approved(i.id) then raise exception ''管理アプリで商品写真の承認が必要です'' using errcode=''42501'';end if;');
 if patched=definition then raise exception 'listing_complete gate anchor missing';end if;
 execute patched;

 definition:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 patched:=replace(definition,'if p_kind=''listing'' then','if p_kind=''listing'' then
  if not app.listing_photos_approved(i.id) then raise exception ''管理アプリで商品写真の承認が必要です'' using errcode=''42501'';end if;');
 if patched=definition then raise exception 'listing queue gate anchor missing';end if;
 execute patched;

 definition:=pg_get_functiondef('app.extension_claim_seller_operation(uuid,text)'::regprocedure);
 patched:=replace(definition,'and i.sold_on is null','and i.sold_on is null and (app.seller_operations.kind<>''listing'' or app.listing_photos_approved(i.id))');
 if patched=definition then raise exception 'listing claim gate anchor missing';end if;
 execute patched;

 definition:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 patched:=replace(definition,'''revision'',i.updated_at','''photo_review_approved'',app.listing_photos_approved(i.id),''revision'',i.updated_at');
 if patched=definition then raise exception 'seller context anchor missing';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261017140000_inspection_receipt_tasks.sql ▼▼▼

-- Reuse the extension's completion ledger without changing its write protocol.
create table if not exists app.marketplace_extension_receipts (
 marketplace text not null,marketplace_item_id text not null,token uuid not null unique default gen_random_uuid(),
 account_label text not null,state text not null check(state in ('reserved','submitting','succeeded','unknown')),
 reserved_by uuid not null,reserved_at timestamptz not null default now(),updated_at timestamptz not null default now(),details text,
 primary key(marketplace,marketplace_item_id)
);
alter table app.marketplace_extension_receipts enable row level security;
grant select on app.marketplace_extension_receipts to authenticated;
create policy receipt_task_completion_read on app.marketplace_extension_receipts for select to authenticated using(app.is_admin());

create table app.receipt_evaluation_tasks (
 item_id uuid primary key references app.items(id) on delete cascade,
 requested_at timestamptz not null,completed_at timestamptz,completed_by uuid references app.staff(id)
);
alter table app.receipt_evaluation_tasks enable row level security;
revoke all on app.receipt_evaluation_tasks from public,anon,authenticated;
grant select on app.receipt_evaluation_tasks to authenticated;
grant all on app.receipt_evaluation_tasks to service_role;
create policy receipt_tasks_admin_read on app.receipt_evaluation_tasks for select to authenticated using(app.is_admin());

create function app.enqueue_inspection_receipt_task() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.action='inspection_complete' then
  insert into app.receipt_evaluation_tasks(item_id,requested_at)
  select id,new.created_at from app.items where id=new.item_id and marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
  on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null;
 end if;
 return new;
end $$;
revoke all on function app.enqueue_inspection_receipt_task() from public,anon,authenticated;
create trigger inspection_receipt_task after insert on app.inventory_workflow_events for each row execute function app.enqueue_inspection_receipt_task();

-- Only explicit inspection-complete actions create tasks; old imported timestamps do not.
insert into app.receipt_evaluation_tasks(item_id,requested_at)
select e.item_id,max(e.created_at) from app.inventory_workflow_events e join app.items i on i.id=e.item_id
where e.action='inspection_complete' and i.inspected_at is not null and i.cleaned_at is not null
and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') group by e.item_id;

create view app.v_receipt_evaluation_tasks with(security_invoker=true) as
select t.item_id as id,t.item_id,t.requested_at,i.sku,i.lot_seq,i.title,p.model_no,i.asin,i.marketplace,i.marketplace_item_id,i.marketplace_url
from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id left join app.products p on p.id=i.product_id
where t.completed_at is null and i.inspected_at is not null and i.cleaned_at is not null
and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
and not exists(select 1 from app.marketplace_extension_receipts r
 where r.marketplace=case when i.marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else i.marketplace::text end
 and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded');
grant select on app.v_receipt_evaluation_tasks to authenticated;

create function app.complete_receipt_evaluation_task(p_item_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 update app.receipt_evaluation_tasks set completed_at=coalesce(completed_at,clock_timestamp()),completed_by=coalesce(completed_by,app.current_staff_id()) where item_id=p_item_id;
 if not found then raise exception '受取評価のやることがありません' using errcode='22023';end if;
end $$;
revoke all on function app.complete_receipt_evaluation_task(uuid) from public,anon;
grant execute on function app.complete_receipt_evaluation_task(uuid) to authenticated;

do $$declare definition text;patched text;begin
 definition:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(definition,'''invoice_tasks'',''photo_reviews'',''listing_tasks'',''actions''','''invoice_tasks'',''photo_reviews'',''listing_tasks'',''actions'',''receipt_tasks''');
 patched:=replace(patched,'when ''invoice_tasks'' then source:=','when ''receipt_tasks'' then source:=$receipt$select to_jsonb(t) d from app.v_receipt_evaluation_tasks t$receipt$;
 when ''invoice_tasks'' then source:=');
 if patched=definition or position('v_receipt_evaluation_tasks' in patched)=0 then raise exception 'Receipt resource anchor missing';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261018051548_reconcile_listing_results.sql ▼▼▼

-- Result checks only: never put an uncertain listing back into the publish queue.
create or replace function app.extension_seller_queue(p_account_ids text[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (
  select o.*,i.sku inventory_sku,(o.status='uncertain') read_only_listing_check,l.external_id,coalesce(l.trade_url,l.url) url,l.trade_key
  from app.seller_operations o join app.items i on i.id=o.item_id left join app.seller_listings l on l.item_id=o.item_id and l.active
  where o.account_id=any(p_account_ids) and (o.status='queued' or (o.status='uncertain' and o.kind='listing'
    and o.result->>'read_check_state'='queued' and o.result->>'read_check_request' is not null and coalesce(o.result->>'read_check_attempt','')<>o.result->>'read_check_request'
    and i.status=o.expected_status and i.updated_at=o.expected_updated_at and i.sales_channel=o.channel and i.sold_on is null))
  order by case when o.status='queued' then 0 else 1 end,o.created_at limit 10
 ) q),'[]'::jsonb);
end $$;

create function app.request_listing_result_check(p_item_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;q app.seller_operations;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '権限がありません' using errcode='42501';end if;
 select * into q from app.seller_operations where item_id=i.id and kind='listing' and status='uncertain' order by created_at desc limit 1 for update;
 if q.id is null or i.status is distinct from q.expected_status or i.updated_at is distinct from q.expected_updated_at or i.sales_channel is distinct from q.channel or i.sold_on is not null then raise exception '商品が更新されています。出品結果を確認してください';end if;
 if q.result->>'read_check_state' in ('queued','running') and (q.result->>'read_check_requested_at')::timestamptz>clock_timestamp()-interval '10 minutes' then return q.id;end if;
 update app.seller_operations set result=(result-'last_check_note')||jsonb_build_object('read_check_request',gen_random_uuid()::text,'read_check_state','queued','read_check_requested_at',clock_timestamp()) where id=q.id;
 return q.id;
end $$;

create function app.extension_claim_listing_result_check(p_id uuid,p_account_id text) returns boolean
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 update app.seller_operations o set result=result||jsonb_build_object('read_check_attempt',result->>'read_check_request','read_check_state','running','read_check_requested_at',clock_timestamp(),'read_check_claimed_at',clock_timestamp())
 where id=p_id and account_id=p_account_id and kind='listing' and status='uncertain'
 and result->>'read_check_state'='queued' and result->>'read_check_request' is not null and coalesce(result->>'read_check_attempt','')<>result->>'read_check_request'
 and exists(select 1 from app.items i where i.id=o.item_id and i.status=o.expected_status and i.updated_at=o.expected_updated_at and i.sales_channel=o.channel and i.sold_on is null);
 return found;
end $$;

create function app.extension_finish_listing_result_check(p_id uuid,p_result jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;ext text:=p_result->>'external_id';u text:=p_result->>'url';observed timestamptz;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_result is null or octet_length(p_result::text)>10000 then raise exception '確認結果が不正です';end if;
 select * into q from app.seller_operations where id=p_id for update;
 if q.kind='listing' and q.status='succeeded' and q.result->>'external_id'=ext and q.result->>'url'=u then return;end if;
 if q.id is null or q.kind<>'listing' or q.status<>'uncertain' or q.result->>'read_check_state' is distinct from 'running'
  or q.result->>'read_check_claimed_at' is null or (q.result->>'read_check_claimed_at')::timestamptz<clock_timestamp()-interval '10 minutes' then raise exception '確認処理の予約がありません';end if;
 if ext is null then
  update app.seller_operations set result=result||jsonb_build_object('read_check_state','done','last_check_note',left(coalesce(p_result->>'note','出品結果を確認できません'),400),'read_check_finished_at',clock_timestamp()) where id=q.id;
  return;
 end if;
 observed:=(p_result->>'observed_at')::timestamptz;
 if observed is null or observed<clock_timestamp()-interval '5 minutes' or observed>clock_timestamp()+interval '1 minute' or observed<q.created_at
  or regexp_replace(coalesce(p_result->>'verified_title',''),'[[:space:]　]+',' ','g')<>regexp_replace(q.payload->>'title','[[:space:]　]+',' ','g')
  or not ((q.channel='メルカリ' and ext~'^m[0-9]+$' and u='https://jp.mercari.com/item/'||ext) or (q.channel='ヤフオク' and ext~'^[a-z][0-9]+$' and u='https://page.auctions.yahoo.co.jp/jp/auction/'||ext)) or u is null then raise exception '出品の商品名・URLを確認できません';end if;
 select * into i from app.items where id=q.item_id for update;
 if lower(coalesce(p_result->>'verified_serial',''))<>lower(split_part(i.sku,'-',1)) or i.status is distinct from q.expected_status or i.updated_at is distinct from q.expected_updated_at or i.sales_channel is distinct from q.channel or i.sold_on is not null then raise exception '商品が更新されています。出品結果は変更しません';end if;
 if exists(select 1 from app.seller_listings where (item_id=i.id and active and (channel<>q.channel or account_id<>q.account_id or external_id<>ext)) or (channel=q.channel and external_id=ext and (item_id<>i.id or account_id<>q.account_id))) then raise exception '別の商品または出品情報と重複しています';end if;
 insert into app.seller_listings(item_id,channel,account_id,external_id,url,observed_at,observed_status) values(i.id,q.channel,q.account_id,ext,u,observed,'出品中')
 on conflict(channel,account_id,external_id) do update set active=true,observed_at=excluded.observed_at,observed_status='出品中';
 update app.items set status='出品中',product_registered_at=coalesce(product_registered_at,observed) where id=i.id;
 update app.seller_operations set status='succeeded',finished_at=clock_timestamp(),result=(result-'last_check_note')||p_result||jsonb_build_object('read_check_state','done','verified_read_only',true,'note','出品済みの商品を確認し、在庫へ反映しました') where id=q.id;
end $$;
revoke all on function app.extension_seller_queue(text[]),app.request_listing_result_check(uuid),app.extension_claim_listing_result_check(uuid,text),app.extension_finish_listing_result_check(uuid,jsonb) from public,anon;
grant execute on function app.extension_seller_queue(text[]),app.request_listing_result_check(uuid),app.extension_claim_listing_result_check(uuid,text),app.extension_finish_listing_result_check(uuid,jsonb) to authenticated;

-- Preserve invoker/RLS and the existing context fields, adding safe check progress.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 definition:=replace(definition,$old$else jsonb_build_object('note',q.result->>'note') end$old$,$new$else jsonb_strip_nulls(jsonb_build_object('note',q.result->>'note','read_check_state',q.result->>'read_check_state','read_check_requested_at',q.result->>'read_check_requested_at','last_check_note',q.result->>'last_check_note')) end$new$);
 execute definition;
end $migration$;


-- ▼▼▼ 20261018053417_listing_result_by_item_id.sql ▼▼▼

-- Reconcile by the external item ID in the real listing URL, without title/serial equality.
drop function app.request_listing_result_check(uuid);
create function app.request_listing_result_check(p_item_id uuid,p_listing_url text default null) returns uuid
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;q app.seller_operations;target text:=nullif(btrim(p_listing_url),'');
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '権限がありません' using errcode='42501';end if;
 select * into q from app.seller_operations where item_id=i.id and kind='listing' and status='uncertain' order by created_at desc limit 1 for update;
 if q.id is null or i.status is distinct from q.expected_status or i.updated_at is distinct from q.expected_updated_at or i.sales_channel is distinct from q.channel or i.sold_on is not null then raise exception '商品が更新されています。出品結果を確認してください';end if;
 if target is not null and not ((q.channel='メルカリ' and target~'^https://jp[.]mercari[.]com/item/m[0-9]+$') or (q.channel='ヤフオク' and target~'^https://page[.]auctions[.]yahoo[.]co[.]jp/jp/auction/[a-z][0-9]+$')) then raise exception '出品先の商品URLを入力してください';end if;
 if q.result->>'read_check_state' in ('queued','running') and (q.result->>'read_check_requested_at')::timestamptz>clock_timestamp()-interval '10 minutes' then return q.id;end if;
 update app.seller_operations set result=(result-'last_check_note')||jsonb_build_object('read_check_url',target,'read_check_request',gen_random_uuid()::text,'read_check_state','queued','read_check_requested_at',clock_timestamp()) where id=q.id;
 return q.id;
end $$;

create or replace function app.extension_finish_listing_result_check(p_id uuid,p_result jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;ext text:=p_result->>'external_id';u text:=p_result->>'url';observed timestamptz;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_result is null or octet_length(p_result::text)>10000 then raise exception '確認結果が不正です';end if;
 select * into q from app.seller_operations where id=p_id for update;
 if q.kind='listing' and q.status='succeeded' and q.result->>'external_id'=ext and q.result->>'url'=u then return;end if;
 if q.id is null or q.kind<>'listing' or q.status<>'uncertain' or q.result->>'read_check_state' is distinct from 'running'
  or q.result->>'read_check_claimed_at' is null or (q.result->>'read_check_claimed_at')::timestamptz<clock_timestamp()-interval '10 minutes' then raise exception '確認処理の予約がありません';end if;
 if ext is null then
  update app.seller_operations set result=result||jsonb_build_object('read_check_state','done','last_check_note',left(coalesce(p_result->>'note','出品結果を確認できません'),400),'read_check_finished_at',clock_timestamp()) where id=q.id;
  return;
 end if;
 observed:=(p_result->>'observed_at')::timestamptz;
 if observed is null or observed<clock_timestamp()-interval '5 minutes' or observed>clock_timestamp()+interval '1 minute' or observed<q.created_at
  or not ((q.channel='メルカリ' and ext~'^m[0-9]+$' and u='https://jp.mercari.com/item/'||ext) or (q.channel='ヤフオク' and ext~'^[a-z][0-9]+$' and u='https://page.auctions.yahoo.co.jp/jp/auction/'||ext)) or u is null then raise exception '出品の商品ID・URLを確認できません';end if;
 if q.result->>'read_check_url' is not null and q.result->>'read_check_url'<>u then raise exception '確認した商品IDが指定の商品URLと一致しません';end if;
 select * into i from app.items where id=q.item_id for update;
 if i.status is distinct from q.expected_status or i.updated_at is distinct from q.expected_updated_at or i.sales_channel is distinct from q.channel or i.sold_on is not null then raise exception '商品が更新されています。出品結果は変更しません';end if;
 if exists(select 1 from app.seller_listings where (item_id=i.id and active and (channel<>q.channel or account_id<>q.account_id or external_id<>ext)) or (channel=q.channel and external_id=ext and (item_id<>i.id or account_id<>q.account_id))) then raise exception '別の商品または出品情報と重複しています';end if;
 insert into app.seller_listings(item_id,channel,account_id,external_id,url,observed_at,observed_status) values(i.id,q.channel,q.account_id,ext,u,observed,'出品中')
 on conflict(channel,account_id,external_id) do update set active=true,observed_at=excluded.observed_at,observed_status='出品中';
 update app.items set status='出品中',product_registered_at=coalesce(product_registered_at,observed) where id=i.id;
 update app.seller_operations set status='succeeded',finished_at=clock_timestamp(),result=(result-'last_check_note')||p_result||jsonb_build_object('read_check_state','done','verified_read_only',true,'note','出品済みの商品を確認し、在庫へ反映しました') where id=q.id;
end $$;
revoke all on function app.request_listing_result_check(uuid,text) from public,anon;
grant execute on function app.request_listing_result_check(uuid,text) to authenticated;


-- ▼▼▼ 20261018235124_deliverer_working_and_held_stock.sql ▼▼▼

-- Workload metrics only: leave the global stock/financial definitions unchanged.
-- Append the new SQL column to preserve the existing view column identities and grants.
create or replace view app.v_deliverer_workload with (security_invoker=true,security_barrier=true) as
with dates as (
 select (now() at time zone 'Asia/Tokyo')::date today,
 ((now() at time zone 'Asia/Tokyo')::date-interval '3 months')::date average_start
)
select s.id deliverer_id,s.name deliverer_name,
 count(*) filter(where not i.is_accessory and (
   i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良')
   or (i.sales_channel in ('自己発送','メルカリ','ヤフオク') and
      (i.status='出品中' or (i.status='取引中' and i.shipped_on is null)))
 )) as "保有在庫",
 avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null
   and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数",
 count(*) filter(where not i.is_accessory and i.status in ('検品中','Amazon返送依頼','商品登録前')) as "作業在庫"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active and (select app.management_reports_allowed()) group by s.id,s.name;


-- ▼▼▼ 20261019014438_delivery_all_products_catalog.sql ▼▼▼

-- Cross-assignee catalog is a separate, strictly read-only projection.
-- It contains no costs, prices, payouts, descriptions, comments, messages or document data.
do $$
declare definition text; patched text;
begin
 definition:=rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),E';\n ');
 patched:=regexp_replace(definition,'app[.]is_admin\(\) OR [a-zA-Z_][a-zA-Z0-9_]*[.]deliverer_id = app[.]current_staff_id\(\)','true');
 if patched=definition then raise exception 'Delivery assignment predicate was not found';end if;
 -- No call to the work-authorized financial helper in this catalog.
 definition:=regexp_replace(patched,'app[.]shared_product_sale_values\(([a-zA-Z_][a-zA-Z0-9_]*)[.]id\)',
  '(select coalesce((select parent.sales_channel from app.items parent where \1.is_accessory and not app.is_standalone_accessory_serial(\1.sku,\1.lot_seq) and not parent.is_accessory and (parent.id=\1.parent_item_id or (\1.parent_item_id is null and parent.lot_seq=\1.lot_seq and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(\1.sku,\1.lot_seq))) limit 1),\1.sales_channel) sales_channel,null::bigint sold_price,null::bigint payout_amount)');
 if definition=patched then raise exception 'Financial display helper was not found';end if;
 execute 'create view app.v_delivery_catalog with(security_invoker=true) as select id,sku,lot_seq,is_accessory,status,work_stream,title,asin,condition,purchased_at,marketplace,tracking_no,sales_channel,deliverer_id,reference_image_url,marketplace_item_id,model_no,marketplace_url from ('||definition||') catalog_source';
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 definition:=replace(definition,'app.read_inventory_page(','app.read_delivery_catalog_snapshot(');
 patched:=replace(definition,'''app.v_delivery_tasks''','''app.v_delivery_catalog''');
 if patched=definition then raise exception 'Delivery page source was not found';end if;
 execute patched;
end $$;
revoke all on app.v_delivery_catalog from public,anon,authenticated;
revoke all on function app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb) from public,anon,authenticated;

-- The user authorized all delivery staff to browse other assignees' products.
-- Only active authenticated staff can invoke this fixed catalog path; no write API is changed.
create function app.read_delivery_catalog_page(p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active and role in ('admin','purchaser','deliverer')) then
  raise exception '権限がありません' using errcode='42501';
 end if;
 return app.read_delivery_catalog_snapshot('delivery',p_filters,p_limit,p_known);
end $$;
revoke all on function app.read_delivery_catalog_page(jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_delivery_catalog_page(jsonb,integer,jsonb) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261019030000_malfunction_report_photos.sql ▼▼▼

-- Private Drive attachments are staged before the existing report transition commits.
create table app.malfunction_report_photos (
 id uuid primary key, item_id uuid not null references app.items(id) on delete cascade,
 request_id uuid not null, uploaded_by uuid not null references app.staff(id),
 drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 sort_order integer not null check(sort_order between 0 and 9),
 event_id uuid references app.inventory_workflow_events(id), created_at timestamptz not null default now(),
 unique(request_id,sort_order)
);
create index malfunction_report_photos_item_event on app.malfunction_report_photos(item_id,event_id,sort_order);
alter table app.malfunction_report_photos enable row level security;
revoke all on app.malfunction_report_photos from public,anon,authenticated;
grant select on app.malfunction_report_photos to authenticated;
grant all on app.malfunction_report_photos to service_role;
create policy malfunction_report_photos_read on app.malfunction_report_photos for select to authenticated using(
 event_id is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id())))
);

create function app.submit_malfunction_report(p_item_id uuid,p_expected_status app.item_status,p_note text,p_request_id uuid,p_photo_ids uuid[])
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare actor uuid:=app.current_staff_id(); n integer;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 if coalesce(cardinality(p_photo_ids),0) not between 1 and 10 or (select count(distinct id) from unnest(p_photo_ids) id)<>cardinality(p_photo_ids) then raise exception '写真は1〜10枚で指定してください' using errcode='22023';end if;
 -- Lock all attachments so their identity and ownership cannot change during submission.
 perform 1 from app.malfunction_report_photos where id=any(p_photo_ids) and item_id=p_item_id and request_id=p_request_id and uploaded_by=actor for update;
 select count(*) into n from app.malfunction_report_photos where id=any(p_photo_ids) and item_id=p_item_id and request_id=p_request_id and uploaded_by=actor and (event_id is null or event_id=p_request_id);
 if n<>cardinality(p_photo_ids) then raise exception '報告写真の保存を確認できません' using errcode='42501';end if;
 perform app.perform_inventory_action(p_item_id,'report',p_expected_status,p_note,p_request_id);
 update app.malfunction_report_photos set event_id=p_request_id where id=any(p_photo_ids);
end $$;
revoke all on function app.submit_malfunction_report(uuid,app.item_status,text,uuid,uuid[]) from public,anon;
grant execute on function app.submit_malfunction_report(uuid,app.item_status,text,uuid,uuid[]) to authenticated;

create function app.read_malfunction_report_photos(p_item_id uuid)
returns table(id uuid,drive_file_id text,sort_order integer) language sql stable security invoker set search_path=pg_catalog,app as $$
 select p.id,p.drive_file_id,p.sort_order from app.malfunction_report_photos p
 where p.item_id=p_item_id and p.event_id=(select e.id from app.inventory_workflow_events e where e.item_id=p_item_id and e.action='report' order by e.created_at desc limit 1)
 order by p.sort_order,p.id
$$;
revoke all on function app.read_malfunction_report_photos(uuid) from public,anon;
grant execute on function app.read_malfunction_report_photos(uuid) to authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261019055632_review_return_tasks.sql ▼▼▼

-- Explicit return tasks survive reads and disappear only when work is resubmitted.
alter table app.photo_reviews add column rejected_at timestamptz;
alter table app.photo_reviews add column rejected_by uuid references app.staff(id);
alter table app.photo_reviews add column rejection_reason text;
create table app.delivery_return_tasks (
 id uuid primary key, item_id uuid not null references app.items(id) on delete cascade,
 kind text not null check(kind in ('photo_return','malfunction_return')),
 reason text not null check(length(btrim(reason)) between 1 and 2000 and reason ~ '[^[:space:]　]'),
 source_at timestamptz not null, actor_id uuid not null references app.staff(id),
 created_at timestamptz not null default clock_timestamp(), resolved_at timestamptz
);
create unique index delivery_return_tasks_active on app.delivery_return_tasks(item_id,kind) where resolved_at is null;
create index delivery_return_tasks_item on app.delivery_return_tasks(item_id,created_at);
alter table app.delivery_return_tasks enable row level security;
revoke all on app.delivery_return_tasks from public,anon,authenticated;
grant select on app.delivery_return_tasks to authenticated;
grant all on app.delivery_return_tasks to service_role;
create policy delivery_return_tasks_read on app.delivery_return_tasks for select to authenticated using(
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id()))
);
create view app.v_delivery_return_tasks with(security_invoker=true) as
 select t.id,t.item_id,t.kind,t.reason,t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url
 from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null;
revoke all on app.v_delivery_return_tasks from public,anon;
grant select on app.v_delivery_return_tasks to authenticated,service_role;

-- Informational cards expire after 24 hours; unresolved work/history remains stored.
create view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
 )
 select distinct on(item_id,kind) *,created_at+interval '24 hours' expires_at from notices
 where created_at>clock_timestamp()-interval '24 hours'
  and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 order by item_id,kind,created_at desc,id;
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;

alter table app.delivery_push_events drop constraint delivery_push_events_kind_check;
alter table app.delivery_push_events add constraint delivery_push_events_kind_check
 check(kind in ('reply','photo','assigned','photo_return','malfunction_return'));
create function app.notify_delivery_return() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 perform app.enqueue_delivery_push(new.item_id,new.kind,new.created_at,new.actor_id);
 return new;
end $$;
revoke all on function app.notify_delivery_return() from public,anon,authenticated;
create trigger delivery_return_task_push after insert on app.delivery_return_tasks for each row execute function app.notify_delivery_return();

create function app.reject_photo_review(p_item_id uuid,p_submitted_at timestamptz,p_reason text,p_request_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare r app.photo_reviews; t app.delivery_return_tasks; actor uuid:=app.current_staff_id(); returned_at timestamptz:=clock_timestamp();
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=actor and is_active) then
  raise exception '写真確認の権限がありません' using errcode='42501';end if;
 if p_request_id is null or p_reason is null or p_reason !~ '[^[:space:]　]' or length(btrim(p_reason)) not between 1 and 2000 then
  raise exception '差し戻し理由を1〜2000文字で入力してください' using errcode='22023';end if;
 -- Serialize against work/status changes, then against approval and submission.
 perform 1 from app.items where id=p_item_id for update;
 select * into t from app.delivery_return_tasks where id=p_request_id;
 if found then
  if t.item_id=p_item_id and t.kind='photo_return' and t.actor_id=actor and t.source_at=p_submitted_at and t.reason=btrim(p_reason) then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';end if;
 select * into r from app.photo_reviews where item_id=p_item_id for update;
 if r.item_id is null or r.submitted_at is distinct from p_submitted_at or r.approved_at is not null or r.rejected_at is not null then
  raise exception '写真の提出状態が更新されています。確認画面を開き直してください' using errcode='40001';end if;
 update app.photo_reviews set rejected_at=returned_at,rejected_by=actor,rejection_reason=btrim(p_reason),
  approved_at=null,approved_by=null,updated_at=returned_at where item_id=p_item_id;
 insert into app.delivery_return_tasks(id,item_id,kind,reason,source_at,actor_id,created_at)
 values(p_request_id,p_item_id,'photo_return',btrim(p_reason),r.submitted_at,actor,returned_at);
end $$;
revoke all on function app.reject_photo_review(uuid,timestamptz,text,uuid) from public,anon;
grant execute on function app.reject_photo_review(uuid,timestamptz,text,uuid) to authenticated;

create function app.resubmit_returned_photos() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if tg_op='INSERT' or new.submitted_at is distinct from old.submitted_at then
  new.rejected_at:=null;new.rejected_by:=null;new.rejection_reason:=null;
  update app.delivery_return_tasks set resolved_at=clock_timestamp()
   where item_id=new.item_id and kind='photo_return' and resolved_at is null and source_at<new.submitted_at;
 end if;
 return new;
end $$;
revoke all on function app.resubmit_returned_photos() from public,anon,authenticated;
create trigger photo_reviews_resubmit_return before insert or update of submitted_at on app.photo_reviews
 for each row execute function app.resubmit_returned_photos();

create function app.track_returned_reports() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if new.action='send_back' then
  insert into app.delivery_return_tasks(id,item_id,kind,reason,source_at,actor_id,created_at)
   values(new.id,new.item_id,'malfunction_return',btrim(new.note),new.created_at,new.actor_id,new.created_at);
  insert into app.item_comments(id,item_id,author_id,body,created_at)
   values(new.id,new.item_id,new.actor_id,'差し戻し理由：'||btrim(new.note),new.created_at);
 elsif new.action in ('report','inspection_complete') then
  update app.delivery_return_tasks set resolved_at=new.created_at
   where item_id=new.item_id and kind='malfunction_return' and resolved_at is null and created_at<new.created_at;
 end if;
 return new;
end $$;
revoke all on function app.track_returned_reports() from public,anon,authenticated;
create trigger inventory_workflow_return_task after insert on app.inventory_workflow_events for each row execute function app.track_returned_reports();

-- Patch the current definitions rather than replacing other workflow/resource changes.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
 patched:=replace(original,'when ''report_cancel'',''send_back'' then',
  'when ''report_cancel'',''send_back'' then' || chr(10) ||
  '  if p_action=''send_back'' and nullif(btrim(p_note),'''') is null then raise exception ''差し戻し理由を入力してください'' using errcode=''22023'';end if;');
 if patched=original then raise exception 'Workflow return anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.approve_photo_review(uuid)'::regprocedure);
 patched:=replace(original,'approved_at is null and exported_photo_count','approved_at is null and rejected_at is null and exported_photo_count');
 if patched=original then raise exception 'Photo approval anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'where r.approved_at is null$q$','where r.approved_at is null and r.rejected_at is null$q$');
 patched:=replace(patched,'case p_resource','case p_resource' || chr(10) ||
  ' when ''return_tasks'' then source:=$q$select to_jsonb(t) d from app.v_delivery_notice_tasks t$q$;');
 if patched=original or strpos(patched,'r.rejected_at is null')=0 then raise exception 'Resource return anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,'when ''photo_review'' then p.approved_at is null','when ''photo_review'' then p.rejected_at is null and p.approved_at is null');
 if patched=original then raise exception 'Admin photo eligibility anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_delivery_push()'::regprocedure);
 patched:=replace(original,'and case e.kind','and case e.kind' || chr(10) ||
  ' when ''photo_return'' then exists(select 1 from app.delivery_return_tasks t where t.item_id=i.id and t.kind=e.kind and t.created_at=e.event_at and t.resolved_at is null)' || chr(10) ||
  ' when ''malfunction_return'' then exists(select 1 from app.delivery_return_tasks t where t.item_id=i.id and t.kind=e.kind and t.created_at=e.event_at and t.resolved_at is null)');
 if patched=original then raise exception 'Delivery return eligibility anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.capture_delivery_push()'::regprocedure);
 patched:=replace(original,'if tg_table_name=''item_comments'' then','if tg_table_name=''item_comments'' then' || chr(10) ||
  ' if exists(select 1 from app.delivery_return_tasks where id=new.id) then return new;end if;');
 if patched=original then raise exception 'Return comment push anchor missing';end if;execute patched;
end $patch$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261019061733_packing_photo_notices.sql ▼▼▼

-- Packing evidence is an admin read receipt, never a listing/shipping approval.
create table app.packing_photo_notices(
 item_id uuid primary key references app.items(id) on delete cascade,
 source_photo_id uuid references app.item_photos(id) on delete set null,
 photo_count integer not null check(photo_count>0),
 submitted_at timestamptz not null default clock_timestamp(),
 checked_at timestamptz,checked_by uuid references app.staff(id)
);
alter table app.packing_photo_notices enable row level security;
revoke all on app.packing_photo_notices from public,anon,authenticated;
grant select on app.packing_photo_notices to authenticated;
grant all on app.packing_photo_notices to service_role;
create policy packing_photo_notices_read on app.packing_photo_notices for select to authenticated
 using(app.is_admin() and exists(select 1 from app.staff where id=app.current_staff_id() and is_active));
create function app.record_packing_photo_notice(p_item_id uuid,p_source_photo_id uuid,p_photo_count integer)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare latest uuid;n integer;saved integer;begin
 perform 1 from app.items where id=p_item_id for update;
 select count(*),count(drive_file_id) into n,saved from app.item_photos where item_id=p_item_id and photo_kind='packing';
 select id into latest from app.item_photos where item_id=p_item_id and photo_kind='packing' order by created_at desc,id desc limit 1;
 if n=0 or n<>p_photo_count or saved<>n or latest is distinct from p_source_photo_id then
  raise exception '梱包写真が更新されています。Googleドライブ追加を再実行してください' using errcode='40001';end if;
 insert into app.packing_photo_notices(item_id,source_photo_id,photo_count) values(p_item_id,latest,n)
 on conflict(item_id) do update set source_photo_id=excluded.source_photo_id,photo_count=excluded.photo_count,
  submitted_at=clock_timestamp(),checked_at=null,checked_by=null
 where app.packing_photo_notices.source_photo_id is distinct from excluded.source_photo_id or app.packing_photo_notices.photo_count<>excluded.photo_count;
end $$;
revoke all on function app.record_packing_photo_notice(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function app.record_packing_photo_notice(uuid,uuid,integer) to service_role;
create function app.acknowledge_packing_photos(p_item_id uuid,p_submitted_at timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ確認できます' using errcode='42501';end if;
 update app.packing_photo_notices set checked_at=coalesce(checked_at,clock_timestamp()),checked_by=coalesce(checked_by,app.current_staff_id())
 where item_id=p_item_id and submitted_at=p_submitted_at;
 if not found then raise exception '新しい梱包写真があります。確認画面を開き直してください' using errcode='40001';end if;
end $$;
revoke all on function app.acknowledge_packing_photos(uuid,timestamptz) from public,anon;
grant execute on function app.acknowledge_packing_photos(uuid,timestamptz) to authenticated;
alter table app.admin_push_events drop constraint admin_push_events_kind_check;
alter table app.admin_push_events add constraint admin_push_events_kind_check
 check(kind in ('malfunction','action','photo_review','invoice','receipts','packing_photo'));
create function app.capture_packing_photo_notice() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 perform app.enqueue_admin_push('packing_photo',new.item_id,new.item_id,null,null,null,new.submitted_at);
 return new;
end $$;
revoke all on function app.capture_packing_photo_notice() from public,anon,authenticated;
create trigger packing_photo_notice_push after insert or update of submitted_at on app.packing_photo_notices
 for each row execute function app.capture_packing_photo_notice();
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'case p_resource',
  'if p_resource=''packing_photos'' and not app.is_admin() then raise exception ''管理者のみ確認できます'' using errcode=''42501'';end if;' || chr(10) ||
  'case p_resource' || chr(10) ||
  'when ''packing_photos'' then source:=$q$select jsonb_build_object(''id'',n.item_id,''item_id'',n.item_id,''submitted_at'',n.submitted_at,''photo_count'',n.photo_count,''sku'',i.sku,''lot_seq'',i.lot_seq,''marketplace'',i.marketplace,''marketplace_item_id'',i.marketplace_item_id,''marketplace_url'',i.marketplace_url) d from app.packing_photo_notices n join app.items i on i.id=n.item_id where n.checked_at is null and exists(select 1 from app.item_photos p where p.item_id=i.id and p.photo_kind=''packing'')$q$;');
 if patched=original then raise exception 'Packing resource anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,'and case e.kind','and case e.kind' || chr(10) ||
  'when ''packing_photo'' then exists(select 1 from app.packing_photo_notices n where n.item_id=e.item_id and n.submitted_at=e.event_at and n.checked_at is null and exists(select 1 from app.item_photos p where p.item_id=n.item_id and p.photo_kind=''packing''))');
 if patched=original then raise exception 'Packing notification anchor missing';end if;execute patched;
end $patch$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261019104521_delivery_notice_completion.sql ▼▼▼

-- Completion is per viewer and exact event; it never approves photos or resolves work.
create table app.delivery_notice_completions (
 staff_id uuid not null references app.staff(id) on delete cascade,
 notice_id text not null check(length(notice_id) between 1 and 200),
 item_id uuid not null references app.items(id) on delete cascade,
 completed_at timestamptz not null default clock_timestamp(),
 primary key(staff_id,notice_id)
);
alter table app.delivery_notice_completions enable row level security;
revoke all on app.delivery_notice_completions from public,anon,authenticated;
grant select on app.delivery_notice_completions to authenticated;
grant all on app.delivery_notice_completions to service_role;
create policy delivery_notice_completions_self on app.delivery_notice_completions for select to authenticated
 using(staff_id=app.current_staff_id() and exists(select 1 from app.staff where id=app.current_staff_id() and is_active));

-- Preserve acknowledgements that predate the explicit completion buttons.
insert into app.delivery_notice_completions(staff_id,notice_id,item_id)
 select n.staff_id,'approved:'||p.item_id::text||':'||extract(epoch from p.approved_at)::text,p.item_id
 from app.item_notice_reads n join app.photo_reviews p on p.item_id=n.item_id
 where p.approved_at is not null and n.photo_read_at>=p.approved_at
 union all
 select n.staff_id,case when t.id is not null then t.id::text else 'reply:'||c.id::text end,c.item_id
 from app.item_notice_reads n join app.item_comments c on c.item_id=n.item_id
 join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
 left join app.delivery_return_tasks t on t.id=c.id
 where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at and n.reply_read_at>=c.created_at
 on conflict do nothing;

create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Keep the view column for compatibility, with no expiration value or timer.
  null::timestamptz expires_at,n.reason
 from latest n
 where auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;

create function app.complete_delivery_notice(p_notice_id text,p_item_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare actor uuid:=app.current_staff_id(); notice record;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=actor and is_active)
 or not exists(select 1 from app.items where id=p_item_id and (app.is_admin() or deliverer_id=actor)) then
  raise exception 'この案内を完了する権限がありません' using errcode='42501';end if;
 if exists(select 1 from app.delivery_notice_completions where staff_id=actor and notice_id=p_notice_id and item_id=p_item_id) then return;end if;
 select * into notice from app.v_delivery_notice_tasks where id=p_notice_id and item_id=p_item_id;
 if not found then raise exception '案内が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 insert into app.delivery_notice_completions(staff_id,notice_id,item_id) values(actor,p_notice_id,p_item_id) on conflict do nothing;
 if notice.kind in ('photo_approved','reply') then
  insert into app.item_notice_reads(staff_id,item_id,reply_read_at,photo_read_at)
  values(actor,p_item_id,case when notice.kind='reply' then notice.created_at end,case when notice.kind='photo_approved' then notice.created_at end)
  on conflict(staff_id,item_id) do update set
   reply_read_at=greatest(app.item_notice_reads.reply_read_at,excluded.reply_read_at),
   photo_read_at=greatest(app.item_notice_reads.photo_read_at,excluded.photo_read_at);
 end if;
end $$;
revoke all on function app.complete_delivery_notice(text,uuid) from public,anon;
grant execute on function app.complete_delivery_notice(text,uuid) to authenticated;

-- Reuse the existing bounded snapshot, adding only the current sales channel.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'''lot_seq'',i.lot_seq)) d from app.photo_reviews',
  '''lot_seq'',i.lot_seq,''sales_channel'',i.sales_channel)) d from app.photo_reviews');
 if patched=original then raise exception 'Photo review item anchor missing';end if;execute patched;
end $patch$;

-- Supplier confirmation stays in conversation history, without a separate admin task/push.
create or replace view app.v_item_action_tasks with(security_invoker=true) as
 select c.id,c.item_id,c.task_kind,c.task_completed_at,c.created_at,
  i.lot_seq,i.sku,app.resolve_task_product_id(i.id) marketplace_item_id
 from app.item_comments c join app.items i on i.id=c.item_id
 where c.task_kind is not null and c.task_kind<>'仕入先確認';
revoke all on app.v_item_action_tasks from public,anon;
grant select on app.v_item_action_tasks to authenticated;
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.capture_admin_push()'::regprocedure);
 patched:=replace(original,'should_send:=new.task_kind is not null and new.task_completed_at is null;',
  'should_send:=new.task_kind is not null and new.task_kind<>''仕入先確認'' and new.task_completed_at is null;');
 if patched=original then raise exception 'Supplier action push anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,'when ''action'' then c.task_kind is not null and c.task_completed_at is null',
  'when ''action'' then c.task_kind is not null and c.task_kind<>''仕入先確認'' and c.task_completed_at is null');
 if patched=original then raise exception 'Pending supplier action push anchor missing';end if;execute patched;
end $patch$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261019134850_reconcile_ended_unsold_listing.sql ▼▼▼

-- Resolve only an ended, unsold listing proven in the original seller account.
-- The existing authorization, reservation, revision and exact URL checks stay in force.
do $patch$
declare d text; marker text := ' if exists(select 1 from app.seller_listings where (item_id=i.id and active'; addition text := $body$
 if p_result->>'ended_without_sale'='true' then
  if q.channel<>'ヤフオク' or p_result->>'account_id' is distinct from q.account_id
   or p_result->>'ownership_source' is distinct from 'seller_closed_list'
   or p_result->'bid_count' is distinct from '0'::jsonb then raise exception '元アカウントの出品終了・入札なしを確認してください';end if;
  if exists(select 1 from app.seller_listings where item_id=i.id and active) then raise exception '有効な出品の紐付けがあります';end if;
  update app.seller_operations set status='failed',finished_at=clock_timestamp(),result=(result-'last_check_note')||p_result||jsonb_build_object('read_check_state','done','verified_read_only',true,'note','出品終了・入札なしを確認しました。自動再出品はしません','read_check_finished_at',clock_timestamp()) where id=q.id;
  return;
 end if;
$body$;
begin
 select pg_get_functiondef('app.extension_finish_listing_result_check(uuid,jsonb)'::regprocedure) into d;
 if strpos(d,marker)=0 then raise exception 'Listing result check definition changed; review before patching';end if;
 d:=replace(d,marker,addition||marker);
 d:=replace(d,'q.status=''succeeded'' and q.result->>','(q.status=''succeeded'' or q.status=''failed'' and q.result->>''ended_without_sale''=''true'') and q.result->>');
 execute d;
end $patch$;


-- ▼▼▼ 20261020022633_work_completion_dates.sql ▼▼▼

-- The historical column is retained so saved dates and invoice months stay intact.
comment on column app.items.packed_on is '作業完了日（旧梱包日）。請求対象月の判定に使用';
alter table app.seller_operations add column work_completed_on date;
alter table app.items add column compensation_report_completed_for timestamptz;

create function app.validate_work_completion_date(p_on date,p_purchased date) returns void
language plpgsql set search_path=pg_catalog,app as $$begin
 if p_on is null or p_on>(clock_timestamp() at time zone 'Asia/Tokyo')::date or p_on<p_purchased then
  raise exception '作業完了日は仕入日以降、当日までの日付を入力してください' using errcode='22023';end if;
end $$;
revoke all on function app.validate_work_completion_date(date,date) from public,anon,authenticated;

create function app.capture_listing_work_date() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$declare purchased date;begin
 if new.kind='listing' then
  select purchased_at into purchased from app.items where id=new.item_id;
  new.work_completed_on:=coalesce(nullif(new.payload->>'work_completed_on','')::date,(clock_timestamp() at time zone 'Asia/Tokyo')::date);
  perform app.validate_work_completion_date(new.work_completed_on,purchased);
 end if;
 return new;
end $$;
revoke all on function app.capture_listing_work_date() from public,anon,authenticated;
create trigger seller_operations_capture_work_date before insert on app.seller_operations for each row execute function app.capture_listing_work_date();

-- External listings record the chosen date only after success, including a later result check.
create function app.finish_listing_work_date() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$begin
 if new.kind='listing' and new.status='succeeded' and old.status is distinct from new.status then
  update app.items set packed_on=coalesce(new.work_completed_on,(new.created_at at time zone 'Asia/Tokyo')::date)
  where id=new.item_id and packed_on is null and sales_channel=new.channel
    and status in ('出品中','取引中','販売済') and product_registered_at is not null;
 end if;
 return new;
end $$;
revoke all on function app.finish_listing_work_date() from public,anon,authenticated;
create trigger seller_operations_finish_work_date after update of status on app.seller_operations for each row execute function app.finish_listing_work_date();

-- Manual FBA/self listing and supplier return remain atomic with their inventory actions.
create function app.record_work_completion_date() returns trigger
language plpgsql set search_path=pg_catalog,app as $$declare chosen date;begin
 if new.packed_on is not null or old.packed_on is not null then return new;end if;
 if (new.sales_channel in ('FBA','自己発送') and new.product_registered_at is not null and old.product_registered_at is null and new.status in ('出品中','取引中','販売済'))
 or (old.status<>'返品処理' and new.status='返品処理' and new.returned_on is not null) then
  chosen:=nullif(current_setting('app.work_completed_on',true),'')::date;
  new.packed_on:=coalesce(chosen,(clock_timestamp() at time zone 'Asia/Tokyo')::date);
  new.packed_completed_at:=coalesce(new.packed_completed_at,clock_timestamp());
 end if;
 return new;
end $$;
revoke all on function app.record_work_completion_date() from public,anon,authenticated;
create trigger zz_items_record_work_completion before update on app.items for each row execute function app.record_work_completion_date();

create function app.perform_dated_inventory_action(p_item_id uuid,p_action text,p_expected_status app.item_status,p_on date,p_request_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;actor uuid:=app.current_staff_id();previous text:=current_setting('app.work_completed_on',true);event app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if p_action not in ('listing_complete','supplier_return_complete') then raise exception '日付登録の対象外です' using errcode='22023';end if;
 perform app.validate_work_completion_date(p_on,i.purchased_at);
 select * into event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if event.item_id=i.id and event.actor_id=actor and event.action=p_action then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';
 end if;
 perform set_config('app.work_completed_on',p_on::text,true);
 perform app.perform_inventory_action(p_item_id,p_action,p_expected_status,null,p_request_id);
 perform set_config('app.work_completed_on',coalesce(previous,''),true);
end $$;
revoke all on function app.perform_dated_inventory_action(uuid,text,app.item_status,date,uuid) from public,anon;
grant execute on function app.perform_dated_inventory_action(uuid,text,app.item_status,date,uuid) to authenticated;

create function app.complete_delivery_work(p_item_id uuid,p_on date) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$declare i app.items;actor uuid:=app.current_staff_id();begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=actor,false) then raise exception 'この商品の作業完了日は登録できません' using errcode='42501';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から作業完了を登録してください' using errcode='22023';end if;
 perform app.validate_work_completion_date(p_on,i.purchased_at);
 if i.packed_on=p_on then return;end if;
 if i.packed_on is not null then raise exception '作業完了日は登録済みです。一覧を再読み込みしてください' using errcode='40001';end if;
 if i.status not in ('動作不良','Amazon補填申請中') then raise exception '動作不良・Amazon補填申請中の商品が対象です' using errcode='22023';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain'))
 or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '実行中の操作の結果を確認してください' using errcode='22023';end if;
 update app.items set packed_on=p_on where id=i.id;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note) values(gen_random_uuid(),i.id,actor,'work_complete',i.status,i.status,p_on::text);
end $$;
revoke all on function app.complete_delivery_work(uuid,date) from public,anon;
grant execute on function app.complete_delivery_work(uuid,date) to authenticated;

create function app.complete_delivery_compensation(p_item_id uuid,p_request_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$declare i app.items;actor uuid:=app.current_staff_id();event app.inventory_workflow_events;begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if p_request_id is null then raise exception '操作IDがありません' using errcode='22023';end if;
 select * into event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if event.item_id=i.id and event.actor_id=actor and event.action='compensation_complete' then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';end if;
 if i.status<>'Amazon補填申請中' or i.sold_on is not null or i.is_accessory then raise exception 'Amazon補填申請中の本体が対象です' using errcode='22023';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '実行中の操作の結果を確認してください' using errcode='22023';end if;
 update app.items set sales_channel='ヤフオク',workflow_decision='compensated',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status='商品登録前' where id=i.id;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status) values(p_request_id,i.id,actor,'compensation_complete',i.status,'商品登録前');
end $$;
revoke all on function app.complete_delivery_compensation(uuid,uuid) from public,anon;
grant execute on function app.complete_delivery_compensation(uuid,uuid) to authenticated;

create function app.complete_compensation_report(p_item_id uuid,p_reported_at timestamptz) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$declare i app.items;actor uuid:=app.current_staff_id();begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=actor),false) then raise exception '管理側のみ操作できます' using errcode='42501';end if;
 if i.status<>'Amazon補填申請中' or p_reported_at is null or i.malfunction_reported_at is distinct from p_reported_at then raise exception '報告が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 update app.items set compensation_report_completed_for=p_reported_at where id=i.id and compensation_report_completed_for is distinct from p_reported_at;
end $$;
revoke all on function app.complete_compensation_report(uuid,timestamptz) from public,anon;
grant execute on function app.complete_compensation_report(uuid,timestamptz) to authenticated;

-- Filter only the acknowledged report; a fresh report on the same item is visible again.
do $$declare def text;begin
 select pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure) into def;
 if strpos(def,'where i.malfunction_reported and')=0 then raise exception 'Snapshot source changed; review before applying';end if;
 execute replace(def,'where i.malfunction_reported and','where (i.status<>''Amazon補填申請中'' or i.compensation_report_completed_for is distinct from i.malfunction_reported_at) and i.malfunction_reported and');
end $$;
do $$declare f record;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prokind='f' and p.prosrc like '%梱包完了から%' loop
 execute replace(pg_get_functiondef(f.oid),'梱包完了から','作業完了から');end loop;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261020023000_yahoo_fault_template_condition.sql ▼▼▼

-- Only the four explicit faulty-photo templates change the inventory condition.
-- Keep the existing actor, ownership, state and sold-item guards.
-- Match the existing production/UI choices; an older migration omitted Other.
alter table app.item_comments drop constraint if exists item_comments_task_kind_check;
alter table app.item_comments add constraint item_comments_task_kind_check check (
 task_kind is null or task_kind in ('Amazon販売','仕入先確認',
 'Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
 'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク','ヤフオク その他')
);
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  update app.items set
   workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;


-- ▼▼▼ 20261020085547_delivery_shipping_requests.sql ▼▼▼

-- One informational request per trading episode; completion never ships an item.
create table app.delivery_shipping_tasks (
 id uuid primary key default gen_random_uuid(),item_id uuid not null references app.items(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),resolved_at timestamptz
);
create unique index delivery_shipping_tasks_active on app.delivery_shipping_tasks(item_id) where resolved_at is null;
alter table app.delivery_shipping_tasks enable row level security;
revoke all on app.delivery_shipping_tasks from public,anon,authenticated;
grant select on app.delivery_shipping_tasks to authenticated;
grant all on app.delivery_shipping_tasks to service_role;
create policy delivery_shipping_tasks_read on app.delivery_shipping_tasks for select to authenticated using (
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id()))
);

alter table app.delivery_push_events drop constraint delivery_push_events_kind_check;
alter table app.delivery_push_events add constraint delivery_push_events_kind_check
 check(kind in ('reply','photo','assigned','photo_return','malfunction_return','shipping'));

create function app.capture_shipping_request() returns trigger language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status is distinct from '取引中' or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif old.status is distinct from new.status then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;
create trigger items_capture_shipping_request after update of status,shipped_on,sales_channel on app.items
 for each row execute function app.capture_shipping_request();

-- Current unshipped trades receive cards, without historical push broadcasts.
insert into app.delivery_shipping_tasks(item_id)
 select id from app.items where status='取引中' and shipped_on is null and sales_channel in ('メルカリ','ヤフオク','自己発送')
 and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq));

create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
  union all
  select 'shipping:'||t.id::text,i.id,'shipping',t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
  where t.resolved_at is null and i.status='取引中' and i.shipped_on is null
   and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Keep the view column for compatibility, with no expiration value or timer.
  null::timestamptz expires_at,n.reason
 from latest n
 where auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;


-- Keep all existing dispatch checks and delivery-only subscription routing.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.claim_delivery_push()'::regprocedure);
 patched:=replace(original,'and case e.kind','and case e.kind'||chr(10)||
  ' when ''shipping'' then i.status=''取引中'' and i.shipped_on is null and i.sales_channel in (''メルカリ'',''ヤフオク'',''自己発送'') and exists(select 1 from app.delivery_shipping_tasks t where t.item_id=i.id and t.created_at=e.event_at and t.resolved_at is null and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=st.id and c.notice_id=''shipping:''||t.id::text and c.item_id=i.id))');
 if patched=original then raise exception 'Shipping push eligibility anchor missing';end if;
 execute patched;
end $patch$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261020090951_delivery_notice_three_day_expiry.sql ▼▼▼

create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
  union all
  select 'shipping:'||t.id::text,i.id,'shipping',t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
  where t.resolved_at is null and i.status='取引中' and i.shipped_on is null
   and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Only listing and shipping requests expire after 72 hours.
  case when n.kind in ('photo_approved','shipping') then n.created_at+interval '72 hours' else null::timestamptz end expires_at,n.reason
 from latest n
 where (n.kind not in ('photo_approved','shipping') or n.created_at+interval '72 hours'>now())
  and auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;




-- ▼▼▼ 20261020091216_admin_listing_task_delay.sql ▼▼▼

-- Remind administrators only when an approved product remains unlisted.
do $migration$
declare original text;patched text;
begin
 select pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure) into original;
 patched:=replace(original,
  $old$r.approved_at is not null and i.sales_channel in ('メルカリ','ヤフオク') and i.status='商品登録前' and i.sold_on is null$old$,
  $new$r.approved_at is not null and i.sales_channel in ('メルカリ','ヤフオク','自己発送','FBA') and r.approved_at<=now()-case when i.sales_channel='FBA' then interval '120 hours' else interval '24 hours' end and i.status='商品登録前' and i.sold_on is null$new$);
 if patched=original then raise exception 'Listing task source changed; review before applying';end if;
 execute patched;
end $migration$;


-- ▼▼▼ 20261020092642_status_driven_notices_shipping_reminders.sql ▼▼▼

create or replace function app.capture_shipping_request() returns trigger language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中' and old.status is distinct from new.status and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;

create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null and i.status='商品登録前' and i.product_registered_at is null and i.sold_on is null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
  union all
  select 'shipping:'||t.id::text,i.id,'shipping',t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
  where t.resolved_at is null and i.status in ('取引中','販売済') and i.shipped_on is null
   and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Keep the view column for compatibility, with no expiration value or timer.
  null::timestamptz expires_at,n.reason
 from latest n
 where auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;




-- Reuse the bounded snapshot and its existing RLS, with an explicit admin guard.
do $migration$
declare original text;patched text;
begin
 select pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure) into original;
 patched:=replace(original,$old$when 'listing_tasks' then$old$,$new$when 'admin_shipping_tasks' then
  if not app.is_admin() then raise exception '管理者のみ閲覧できます' using errcode='42501';end if;
  source:=$shipping$select to_jsonb(s) d from (select t.id,i.id item_id,i.sku,i.lot_seq,i.sales_channel,i.marketplace,i.marketplace_item_id,i.marketplace_url,t.created_at from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null and t.created_at<=now()-interval '24 hours' and i.status in ('取引中','販売済') and i.shipped_on is null and i.sales_channel in ('メルカリ','ヤフオク','自己発送')) s$shipping$;
 when 'listing_tasks' then$new$);
 if patched=original then raise exception 'Snapshot listing branch changed';end if;
 execute patched;
end $migration$;

-- Existing cards were seeded without push events. Restore their actual first
-- trading observation from the latest transition in the audit history.
update app.delivery_shipping_tasks t set created_at=history.started_at
from lateral (select 1) anchor,app.items i,
lateral(select a.created_at started_at from app.audit_log a
 where a.table_name='items' and a.row_id=i.id and a.new_data->>'status'='取引中'
 and a.old_data->>'status' is distinct from '取引中'
 order by a.created_at desc limit 1) history
where t.item_id=i.id and t.resolved_at is null and history.started_at<t.created_at
 and not exists(select 1 from app.delivery_push_events e where e.kind='shipping' and e.item_id=t.item_id and e.event_at=t.created_at);


-- ▼▼▼ 20261020111259_return_without_sales_days.sql ▼▼▼

-- Return processing has no selling-duration value. Keep all business dates intact.
do $migration$
declare original text;patched text;
begin
 select pg_get_viewdef('app.v_items'::regclass,true) into original;
 patched:=replace(original,'i.sold_on - i.purchased_at AS days_to_sell',
  $replacement$CASE WHEN i.status<>'返品処理' THEN i.sold_on-i.purchased_at END AS days_to_sell$replacement$);
 patched:=replace(patched,'WHEN i.sold_on IS NULL THEN CURRENT_DATE - i.purchased_at',
  $replacement$WHEN i.sold_on IS NULL AND i.status<>'返品処理' THEN CURRENT_DATE-i.purchased_at$replacement$);
 if patched=original then raise exception 'Inventory duration definition changed';end if;
 execute 'create or replace view app.v_items with(security_invoker=true) as '||patched;
 select pg_get_viewdef('app.v_monthly_summary'::regclass,true) into original;
 patched:=replace(original,'avg(items.sold_on - items.purchased_at)',
  $replacement$avg(case when not exists(select 1 from app.items returned_item where returned_item.id=items.id and returned_item.status='返品処理') then items.sold_on-items.purchased_at end)$replacement$);
 if patched=original then raise exception 'Monthly duration definition changed';end if;
 execute 'create or replace view app.v_monthly_summary as '||patched;
 select pg_get_viewdef('app.v_product_performance'::regclass,true) into original;
 patched:=replace(original,'avg(i.sold_on - i.purchased_at)',
  $replacement$avg(case when i.status<>'返品処理' then i.sold_on-i.purchased_at end)$replacement$);
 if patched=original then raise exception 'Product duration definition changed';end if;
 execute 'create or replace view app.v_product_performance as '||patched;
end $migration$;


-- ▼▼▼ 20261020130640_reflect_original_product_photos.sql ▼▼▼

-- Only the authenticated Edge handler may register independent copies of original Drive photos.
create or replace function app.record_reflected_product_photo(p_item_id uuid,p_source_photo_id uuid,p_staff_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,app as $$
declare target app.items; source_item app.items; source_photo app.item_photos; actor app.staff;
 serial text; target_path text; photo_id uuid;
begin
 select * into actor from app.staff where id=p_staff_id and is_active;
 select * into target from app.items where id=p_item_id for update;
 if actor.id is null or target.id is null or (actor.role<>'admin' and target.deliverer_id is distinct from actor.id) then
  raise exception 'Photo permission denied' using errcode='42501';
 end if;
 serial:=substring(target.sku from '^([0-9]+)[aA]+-');
 if serial is null or target.status<>'商品登録前' then raise exception 'Target must be an unlisted a-series item' using errcode='22023';end if;
 select * into source_photo from app.item_photos where id=p_source_photo_id;
 select * into source_item from app.items where id=source_photo.item_id;
 if source_photo.id is null or source_item.lot_seq is distinct from target.lot_seq
  or split_part(source_item.sku,'-',1) is distinct from serial or coalesce(source_item.is_accessory,false)
  or coalesce(source_photo.photo_kind,'product')<>'product' or source_photo.drive_file_id is null or source_photo.uploaded_by is null then
  raise exception 'Source must be an original product photo saved to Drive' using errcode='22023';
 end if;
 target_path:=target.sku||'/reflected-'||source_photo.id::text||'.jpg';
 select id into photo_id from app.item_photos where item_id=target.id and storage_path=target_path;
 if photo_id is not null then return photo_id;end if;
 insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind,created_at)
 values(target.id,target_path,actor.id,'product',clock_timestamp()) returning id into photo_id;
 return photo_id;
end $$;
revoke all on function app.record_reflected_product_photo(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function app.record_reflected_product_photo(uuid,uuid,uuid) to service_role;


-- ▼▼▼ 20261020144000_restore_malfunction_remote_transfer.sql ▼▼▼

-- Restore the registered-remote transfer for the eight explicit Yahoo photo templates.
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare previous_channel app.sales_channel;
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 select sales_channel into previous_channel from app.items where id=new.item_id for update;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  -- Only registered remotes are moved. Other templates keep all accessories.
  if new.task_kind in ('Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
                       'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク')
   and exists(select 1 from app.items body join app.items remote
     on app.product_serial(remote.sku,remote.lot_seq)=app.product_serial(body.sku,body.lot_seq)
     where body.id=new.item_id and not body.is_accessory and remote.is_accessory and remote.title ilike '%リモコン%') then
   -- Transfer before the body update can synchronize the accessory SKU.
   perform app.prepare_yahoo_auction_item(new.item_id);
  end if;
  update app.items set
   workflow_previous_sales_channel=previous_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;


-- ▼▼▼ 20261021022419_shipping_dates_per_trade.sql ▼▼▼

-- A shipping date preceding the confirmed purchase belongs to an older episode.
-- Changing the current row is audited by the existing items_audit trigger.
create function app.clear_prior_trade_shipping_date() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if new.status='取引中' and new.sold_on is null and new.shipped_on is not null
  and new.sales_channel in ('メルカリ','ヤフオク','自己発送')
  and new.seller_trade_key ~ '^[a-z][0-9]+:20[0-9]{2}-[01][0-9]-[0-3][0-9](T[0-2][0-9]:[0-5][0-9])?$'
  and substring(new.seller_trade_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})') > to_char(new.shipped_on,'YYYY-MM-DD')
 then new.shipped_on:=null;end if;
 return new;
end $$;
revoke all on function app.clear_prior_trade_shipping_date() from public,anon,authenticated;
create trigger items_clear_prior_trade_shipping_date
 before update of status,seller_trade_key,sales_channel on app.items
 for each row execute function app.clear_prior_trade_shipping_date();

-- Restoring an erroneously shipped current trade must also restore its request.
create or replace function app.capture_shipping_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中' and (old.status is distinct from new.status or old.shipped_on is not null)
  and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;
notify pgrst,'reload schema';


-- ▼▼▼ 20261021051000_inherit_unassigned_accessory_deliverer.sql ▼▼▼

-- A linked accessory without an assignee must follow its body, otherwise
-- delivery RLS correctly hides it from the body's assigned staff.
-- Preserve explicit accessory assignments and all existing RLS policies.
create function app.inherit_unassigned_accessory_deliverer()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_accessory and new.parent_item_id is not null and new.deliverer_id is null then
    select p.deliverer_id into new.deliverer_id from app.items p
      where p.id=new.parent_item_id and not p.is_accessory;
  end if;
  return new;
end $$;
revoke all on function app.inherit_unassigned_accessory_deliverer() from public,anon,authenticated;

-- Run after the existing before-insert parent-linking trigger (alphabetical order).
create trigger items_zz_inherit_unassigned_accessory_deliverer
before insert or update of parent_item_id,deliverer_id,is_accessory on app.items
for each row execute function app.inherit_unassigned_accessory_deliverer();

create function app.assign_unassigned_child_accessories()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not new.is_accessory and new.deliverer_id is not null
     and new.deliverer_id is distinct from old.deliverer_id then
    update app.items a set deliverer_id=new.deliverer_id
      where a.is_accessory and a.parent_item_id=new.id and a.deliverer_id is null;
  end if;
  return new;
end $$;
revoke all on function app.assign_unassigned_child_accessories() from public,anon,authenticated;
create trigger items_assign_unassigned_child_accessories
after update of deliverer_id on app.items
for each row execute function app.assign_unassigned_child_accessories();

-- Repair only confirmed links with a missing assignment. Existing audit records
-- capture before/after data; SKU, purchase details and explicit holders stay intact.
update app.items a set deliverer_id=p.deliverer_id
from app.items p where a.is_accessory and a.parent_item_id=p.id
  and a.deliverer_id is null and not p.is_accessory and p.deliverer_id is not null;


-- ▼▼▼ 20261021073308_spare_accessory_holder_identity.sql ▼▼▼

-- Keep the source holder separate from the buyer of a separately registered accessory.
create or replace function app.queue_spare_shipping(p_spare_id uuid,p_item_id uuid,p_accessory_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s app.spare_accessories; i app.items; a app.items; task_id uuid;
begin
  if auth.uid() is null or app.current_role() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '発送依頼を作成する権限がありません' using errcode='42501';
  end if;
  select * into s from app.spare_accessories where id=p_spare_id for update;
  select * into i from app.items where id=p_item_id;
  select * into a from app.items where id=p_accessory_id;
  if s.id is null or i.id is null or a.id is null or s.used_for_item_id is distinct from i.id
    or not a.is_accessory or a.lot_seq is distinct from i.lot_seq
    or a.deliverer_id is distinct from i.deliverer_id
    or a.title is distinct from s.title or a.marketplace_item_id is distinct from s.marketplace_item_id
    -- For an existing main item, i and a are the same newly registered accessory.
    -- Its buyer is independent of the spare holder who sends it.
    or (i.is_accessory and a.id is distinct from i.id)
    or (not i.is_accessory and a.purchaser_id is distinct from coalesce(s.owner_staff_id,i.purchaser_id))
    or (not app.is_admin() and (s.owner_staff_id is distinct from app.current_staff_id()
      or i.purchaser_id is distinct from app.current_staff_id())) then
    raise exception '予備と付属品の紐づけを確認できません' using errcode='22023';
  end if;
  if s.owner_staff_id is null or i.deliverer_id is null or s.owner_staff_id=i.deliverer_id then return null; end if;
  if not exists(select 1 from app.staff where id=s.owner_staff_id and is_active)
    or not exists(select 1 from app.staff where id=i.deliverer_id and is_active) then
    raise exception '発送元または発送先の担当者が無効です' using errcode='22023';
  end if;
  insert into app.spare_shipping_tasks(spare_id,item_id,accessory_item_id,owner_staff_id,recipient_staff_id,
    title,manufacturer,marketplace,marketplace_item_id,usage_note,lot_seq)
  values(s.id,i.id,a.id,s.owner_staff_id,i.deliverer_id,s.title,s.manufacturer,s.marketplace,
    s.marketplace_item_id,s.usage_note,i.lot_seq)
  on conflict(spare_id) do nothing returning id into task_id;
  if task_id is null then
    select id into task_id from app.spare_shipping_tasks where spare_id=s.id
      and item_id=i.id and accessory_item_id=a.id;
    if task_id is null then raise exception '既存の発送依頼と紐づけが異なります' using errcode='22023'; end if;
  end if;
  return task_id;
end $$;


-- ▼▼▼ 20261021132239_reconcile_existing_shipping_requests.sql ▼▼▼

-- The earlier safeguard only ran on the next status observation. Repair rows
-- already observed before it was installed, without waiting for another scan.
-- A shipment on/after the purchase date and completed/cancelled sales are kept.
drop trigger items_clear_prior_trade_shipping_date on app.items;
create trigger items_clear_prior_trade_shipping_date
 before update of status,seller_trade_key,sales_channel,shipped_on on app.items
 for each row execute function app.clear_prior_trade_shipping_date();

create or replace function app.capture_shipping_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中'
  and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;

-- Only current, exactly matched marketplace trades can be reconciled in bulk.
-- Touching status also restores a missing request when shipped_on was already null.
update app.items i set status=i.status
where i.status='取引中' and i.sold_on is null
 and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
 and exists(select 1 from app.seller_listings l where l.item_id=i.id and l.active
  and l.channel=i.sales_channel and l.observed_status='取引中'
  and l.trade_key=i.seller_trade_key)
 and ((i.shipped_on is not null
   and i.seller_trade_key ~ '^[a-z][0-9]+:20[0-9]{2}-[01][0-9]-[0-3][0-9](T[0-2][0-9]:[0-5][0-9])?$'
   and substring(i.seller_trade_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})')>to_char(i.shipped_on,'YYYY-MM-DD'))
  or (i.shipped_on is null and not exists(select 1 from app.delivery_shipping_tasks t
   where t.item_id=i.id and t.resolved_at is null)));

notify pgrst,'reload schema';


-- ▼▼▼ 20261021133336_stop_inferred_unshipped_requests.sql ▼▼▼

-- A date inconsistency is not evidence that a shipment has not happened.
-- Never erase a shipping date or create a request solely from that inference.
drop trigger if exists items_clear_prior_trade_shipping_date on app.items;

create or replace function app.capture_shipping_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中' and (old.status is distinct from new.status or old.shipped_on is not null)
  and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;

-- Reverse only the two unapproved automatic corrections, and only if no later
-- item update has occurred. Explicitly approved corrections (2366) are preserved.
update app.items i set shipped_on=(a.old_data->>'shipped_on')::date
from app.audit_log a
where i.sku in ('2362-AALL-20260920-2200','2323-AALL-20260915-1310')
 and i.status='取引中' and i.sold_on is null and i.shipped_on is null
 and a.table_name='items' and a.row_id=i.id and a.created_at=i.updated_at
 and a.old_data->>'shipped_on' is not null and a.new_data->>'shipped_on' is null
 and a.old_data->>'status'='取引中' and a.new_data->>'status'='取引中';

notify pgrst,'reload schema';


-- ▼▼▼ 20261021145855_retire_yahoo_action_push.sql ▼▼▼

-- Yahoo workflow instructions remain comments, but their former admin action
-- task was merged into the approval/age-based listing task. Match the UI filter.
do $migration$
declare original text;patched text;
begin
 original:=pg_get_functiondef('app.capture_admin_push()'::regprocedure);
 patched:=replace(original,
  $old$new.task_kind<>'仕入先確認' and new.task_completed_at is null$old$,
  $new$new.task_kind<>'仕入先確認' and new.task_kind not like '%ヤフオク%' and new.task_completed_at is null$new$);
 if patched=original and position($guard$new.task_kind not like '%ヤフオク%'$guard$ in original)=0 then
  raise exception 'Admin action capture changed; review exclusion';
 end if;
 execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,
  $old$c.task_kind<>'仕入先確認' and c.task_completed_at is null$old$,
  $new$c.task_kind<>'仕入先確認' and c.task_kind not like '%ヤフオク%' and c.task_completed_at is null$new$);
 if patched=original and position($guard$c.task_kind not like '%ヤフオク%'$guard$ in original)=0 then
  raise exception 'Admin action dispatch changed; review exclusion';
 end if;
 execute patched;
end $migration$;

-- Preserve the instruction, its completion state, and sent notification history.
-- Stop retries already queued by the retired task, including in-flight retries.
update app.admin_push_deliveries d set state='cancelled'
from app.admin_push_events e,app.item_comments c
where d.event_id=e.id and e.kind='action' and e.source_id=c.id
 and c.task_kind like '%ヤフオク%' and d.state in ('pending','sending');

notify pgrst,'reload schema';


-- ▼▼▼ 20261021152757_seller_feedback_durable_receipts.sql ▼▼▼

-- Seller-side buyer feedback is independent from buyer receipt evaluation.
create table app.seller_feedback_receipts (
 channel text not null check(channel in ('メルカリ','ヤフオク')),
 external_id text not null,
 account_id text not null,
 item_id uuid not null references app.items(id),
 trade_key text not null,
 owner_id uuid not null,
 token uuid not null default gen_random_uuid(),
 state text not null check(state in ('reserved','submitting','succeeded','unknown','skipped')),
 note text not null default '',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(channel,external_id)
);
alter table app.seller_feedback_receipts enable row level security;
revoke all on app.seller_feedback_receipts from public,anon,authenticated;
grant select,insert,update on app.seller_feedback_receipts to authenticated;
create policy seller_feedback_admin on app.seller_feedback_receipts for all to authenticated
 using ((select app.is_admin())) with check ((select app.is_admin()));

create function app.seller_feedback_candidates(p_account_id text,p_ids text[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_account_id not in ('mercari-1','mercari-2','auctions-1','auctions-2') or p_account_id is null or coalesce(cardinality(p_ids),0)>40 then raise exception '対象を確認してください';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('external_id',l.external_id,'item_id',i.id,'sku',i.sku,'trade_key',l.trade_key,'state',r.state))
 from app.seller_listings l join app.items i on i.id=l.item_id
 left join app.seller_feedback_receipts r on r.channel=l.channel::text and r.external_id=l.external_id
 where l.account_id=p_account_id and l.external_id=any(p_ids) and l.active
 and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key and l.trade_key<>l.external_id
 and l.observed_status in ('取引中','販売済') and i.status in ('取引中','販売済')
 and i.seller_cancelled_at is null and not coalesce(i.malfunction_reported,false)
 and not exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain'))),'[]'::jsonb);
end $$;

create function app.seller_feedback_record(p_account_id text,p_external_id text,p_trade_key text,p_action text,p_token uuid default null,p_note text default '')
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare candidate jsonb; receipt app.seller_feedback_receipts; ch text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ' when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク' end;
 if ch is null or p_external_id is null or not(case when ch='メルカリ' then p_external_id~'^m[0-9]+$' else p_external_id~'^[a-z][0-9]+$' end) or length(coalesce(p_note,''))>500 then raise exception '対象を確認してください';end if;
 perform pg_advisory_xact_lock(hashtextextended(ch||':'||p_external_id,1645));
 select * into receipt from app.seller_feedback_receipts where channel=ch and external_id=p_external_id for update;
 if p_action='reserve' then
  if receipt.external_id is not null then return jsonb_build_object('claimed',false,'state',receipt.state);end if;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が一致しません';end if;
  insert into app.seller_feedback_receipts(channel,external_id,account_id,item_id,trade_key,owner_id,state)
  values(ch,p_external_id,p_account_id,(candidate->>'item_id')::uuid,p_trade_key,auth.uid(),'reserved') returning * into receipt;
  return jsonb_build_object('claimed',true,'state',receipt.state,'token',receipt.token);
 end if;
 if receipt.external_id is null or receipt.owner_id<>auth.uid() or receipt.account_id<>p_account_id or receipt.trade_key is distinct from p_trade_key or receipt.token is distinct from p_token then raise exception '評価予約が一致しません';end if;
 if p_action='begin' then
  if receipt.state<>'reserved' then raise exception '評価は再送できません';end if;
  perform pg_advisory_xact_lock(hashtextextended(receipt.item_id::text,179050));
  perform 1 from app.items where id=receipt.item_id for update;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が変更されました';end if;
 elsif p_action='complete' then
  if receipt.state<>'submitting' then raise exception '送信状態が一致しません';end if;
 elsif p_action='unknown' then
  if receipt.state not in ('reserved','submitting') then raise exception '送信状態が一致しません';end if;
 elsif p_action='skip' then
  if receipt.state<>'reserved' then raise exception '送信状態が一致しません';end if;
 else raise exception '評価操作を確認してください';end if;
 update app.seller_feedback_receipts set state=case p_action when 'begin' then 'submitting' when 'complete' then 'succeeded' when 'skip' then 'skipped' else 'unknown' end,
 note=coalesce(p_note,''),updated_at=clock_timestamp() where channel=ch and external_id=p_external_id returning * into receipt;
 return jsonb_build_object('state',receipt.state);
end $$;
revoke all on function app.seller_feedback_candidates(text,text[]) from public,anon;
revoke all on function app.seller_feedback_record(text,text,text,text,uuid,text) from public,anon;
grant execute on function app.seller_feedback_candidates(text,text[]) to authenticated;
grant execute on function app.seller_feedback_record(text,text,text,text,uuid,text) to authenticated;


-- ▼▼▼ 20261021154639_seller_feedback_result_review.sql ▼▼▼

create or replace function app.seller_feedback_record(p_account_id text,p_external_id text,p_trade_key text,p_action text,p_token uuid default null,p_note text default '')
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare candidate jsonb; receipt app.seller_feedback_receipts; ch text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ' when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク' end;
 if ch is null or p_external_id is null or not(case when ch='メルカリ' then p_external_id~'^m[0-9]+$' else p_external_id~'^[a-z][0-9]+$' end) or length(coalesce(p_note,''))>500 then raise exception '対象を確認してください';end if;
 perform pg_advisory_xact_lock(hashtextextended(ch||':'||p_external_id,1645));
 select * into receipt from app.seller_feedback_receipts where channel=ch and external_id=p_external_id for update;
 if p_action='reserve' then
  if receipt.external_id is not null then return jsonb_build_object('claimed',false,'state',receipt.state);end if;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が一致しません';end if;
  insert into app.seller_feedback_receipts(channel,external_id,account_id,item_id,trade_key,owner_id,state)
  values(ch,p_external_id,p_account_id,(candidate->>'item_id')::uuid,p_trade_key,auth.uid(),'reserved') returning * into receipt;
  return jsonb_build_object('claimed',true,'state',receipt.state,'token',receipt.token);
 end if;
 if receipt.external_id is null or receipt.owner_id<>auth.uid() or receipt.account_id<>p_account_id or receipt.trade_key is distinct from p_trade_key then raise exception '評価予約が一致しません';end if;
 -- Manual result review only: this does not reset the reservation or authorize a site submission.
 if p_action='review' and receipt.state='unknown' then return jsonb_build_object('state',receipt.state,'token',receipt.token);end if;
 if receipt.token is distinct from p_token then raise exception '評価予約が一致しません';end if;
 if p_action='begin' then
  if receipt.state<>'reserved' then raise exception '評価は再送できません';end if;
  perform pg_advisory_xact_lock(hashtextextended(receipt.item_id::text,179050));
  perform 1 from app.items where id=receipt.item_id for update;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が変更されました';end if;
 elsif p_action='complete' then
  if receipt.state<>'submitting' and not(receipt.state='unknown' and p_note='実画面で完了を再確認') then raise exception '送信状態が一致しません';end if;
 elsif p_action='unknown' then
  if receipt.state not in ('reserved','submitting') then raise exception '送信状態が一致しません';end if;
 elsif p_action='skip' then
  if receipt.state<>'reserved' then raise exception '送信状態が一致しません';end if;
 else raise exception '評価操作を確認してください';end if;
 update app.seller_feedback_receipts set state=case p_action when 'begin' then 'submitting' when 'complete' then 'succeeded' when 'skip' then 'skipped' else 'unknown' end,
 note=coalesce(p_note,''),updated_at=clock_timestamp() where channel=ch and external_id=p_external_id returning * into receipt;
 return jsonb_build_object('state',receipt.state);
end $$;


-- ▼▼▼ 20261022011855_listing_ai_keywords.sql ▼▼▼

create table app.listing_ai_keywords (
 item_id uuid not null references app.items(id) on delete cascade,
 fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
 keywords text not null default '',
 claim_id uuid not null default gen_random_uuid(),
 actor_id uuid not null references auth.users(id),
 state text not null check (state in ('pending','ready','failed')),
 attempted_at timestamptz not null default now(),
 primary key(item_id,fingerprint)
);
alter table app.listing_ai_keywords enable row level security;
revoke all on app.listing_ai_keywords from public,anon,authenticated;
grant select,insert,update on app.listing_ai_keywords to service_role;
create index listing_ai_keywords_attempted on app.listing_ai_keywords(attempted_at);

create table app.listing_ai_attempts (
 claim_id uuid primary key,
 actor_id uuid not null references auth.users(id),
 attempted_at timestamptz not null default now()
);
alter table app.listing_ai_attempts enable row level security;
revoke all on app.listing_ai_attempts from public,anon,authenticated;
grant select,insert,delete on app.listing_ai_attempts to service_role;
create index listing_ai_attempts_time on app.listing_ai_attempts(attempted_at);

-- Only the Edge Function may claim; it validates Auth.getUser and item assignment first.
-- A global advisory lock makes the quota and per-input claim atomic across instances.
create function app.claim_listing_ai_keywords(p_item uuid,p_fingerprint text,p_actor uuid,p_force boolean default false)
returns jsonb language plpgsql security invoker set search_path=app,pg_temp as $$
declare row app.listing_ai_keywords; token uuid; history jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('app.listing_ai_keywords'));
 select * into row from app.listing_ai_keywords where item_id=p_item and fingerprint=p_fingerprint;
 select coalesce(jsonb_agg(keywords),'[]'::jsonb) into history from (
   select keywords from app.listing_ai_keywords where item_id=p_item and keywords<>'' order by attempted_at desc limit 20
 ) h;
 if row.state='ready' and not p_force then return jsonb_build_object('keywords',row.keywords,'previous',history,'cached',true); end if;
 if row.attempted_at>now()-interval '45 seconds' and (row.state<>'ready' or p_force) then
   return jsonb_build_object('wait',true);
 end if;
 if (select count(*) from app.listing_ai_attempts where attempted_at>now()-interval '1 hour' and actor_id=p_actor)>=20
 or (select count(*) from app.listing_ai_attempts where attempted_at>now()-interval '1 day')>=100 then
   return jsonb_build_object('limited',true);
 end if;
 token:=gen_random_uuid();
 delete from app.listing_ai_attempts where attempted_at<now()-interval '30 days';
 insert into app.listing_ai_attempts(claim_id,actor_id) values(token,p_actor);
 insert into app.listing_ai_keywords(item_id,fingerprint,actor_id,state,claim_id)
 values(p_item,p_fingerprint,p_actor,'pending',token)
 on conflict(item_id,fingerprint) do update set actor_id=p_actor,state='pending',claim_id=token,attempted_at=now();
 return jsonb_build_object('claim',token,'previous',history);
end $$;
revoke all on function app.claim_listing_ai_keywords(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function app.claim_listing_ai_keywords(uuid,text,uuid,boolean) to service_role;


-- ▼▼▼ 20261022034237_explicit_damage_and_shipping_actions.sql ▼▼▼

alter table app.items add column has_physical_damage boolean not null default false;
alter table app.inventory_workflow_events add column has_physical_damage boolean not null default false;
comment on column app.items.has_physical_damage is 'Explicit damage checkbox from the current malfunction report; never inferred from condition.';

create function app.reset_report_physical_damage() returns trigger language plpgsql set search_path=pg_catalog,app as $$
begin
 if new.malfunction_reported_at is distinct from old.malfunction_reported_at then new.has_physical_damage:=false; end if;
 return new;
end $$;
create trigger items_reset_report_physical_damage before update on app.items for each row execute function app.reset_report_physical_damage();

create function app.report_item_with_damage(p_item_id uuid,p_expected_status app.item_status,p_note text,p_request_id uuid,p_photo_ids uuid[],p_has_physical_damage boolean)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare actor uuid:=app.current_staff_id(); i app.items; e app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not (app.is_admin() or i.deliverer_id=actor or (app.current_role()='purchaser' and i.purchaser_id=actor)) then raise exception '担当商品のみ報告できます' using errcode='42501';end if;
 if p_has_physical_damage is null then raise exception '破損の確認内容がありません' using errcode='22023';end if;
 select * into e from app.inventory_workflow_events where id=p_request_id;
 if found then
  if e.item_id<>i.id or e.actor_id<>actor or e.action<>'report' or e.note is distinct from nullif(btrim(p_note),'') or e.has_physical_damage<>p_has_physical_damage then raise exception '操作IDが重複しています' using errcode='22023';end if;
  return;
 end if;
 if coalesce(cardinality(p_photo_ids),0)>0 then perform app.submit_malfunction_report(p_item_id,p_expected_status,p_note,p_request_id,p_photo_ids);
 else perform app.perform_inventory_action(p_item_id,'report',p_expected_status,p_note,p_request_id);end if;
 update app.items set has_physical_damage=p_has_physical_damage where id=p_item_id;
 update app.inventory_workflow_events set has_physical_damage=p_has_physical_damage where id=p_request_id;
end $$;
revoke all on function app.report_item_with_damage(uuid,app.item_status,text,uuid,uuid[],boolean) from public,anon;
grant execute on function app.report_item_with_damage(uuid,app.item_status,text,uuid,uuid[],boolean) to authenticated;

do $$declare d text;begin
 select regexp_replace(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),';\s*$','') into d;
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as select v.*,i.has_physical_damage from ('||d||') v join app.items i on i.id=v.id';
end $$;

-- A generated code plus the user's explicit shipment confirmation replaces the UI receipt scan.
-- Keep the old proof paths for already-loaded clients and post-box packages.
do $$declare d text; old_guard text:=$guard$(proof.kind='register_package' and (p_payload->>'posted')::boolean is true)$guard$;begin
 select pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure) into d;
 if position(old_guard in d)=0 then raise exception 'Shipping proof guard changed; review before patching';end if;
 d:=replace(d,old_guard,$guard$(proof.kind in ('register_package','shipping_code') and (p_payload->>'posted')::boolean is true)$guard$);
 execute d;
end $$;


-- ▼▼▼ 20261022064146_close_verified_shipping_task.sql ▼▼▼

-- A verified notification closes the current request, without guessing a dispatch date.
create function app.close_verified_shipping_task() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if new.kind<>'ship_notice' or new.status<>'succeeded' or new.result->>'notified' is distinct from 'true'
  or nullif(new.payload->>'trade_key','') is null then return new;end if;
 perform 1 from app.items i join app.seller_listings l on l.item_id=i.id and l.active
 where i.id=new.item_id and i.sales_channel=new.channel and l.channel=new.channel
  and l.account_id=new.account_id and l.trade_key=new.payload->>'trade_key'
  and i.seller_trade_key=new.payload->>'trade_key'
 for update of i;
 if not found then return new;end if;
 update app.delivery_shipping_tasks set resolved_at=clock_timestamp()
 where item_id=new.item_id and resolved_at is null and created_at<=new.created_at;
 return new;
end $$;
revoke all on function app.close_verified_shipping_task() from public,anon,authenticated;
create trigger seller_operations_close_verified_shipping_task
 after update of status,result on app.seller_operations
 for each row execute function app.close_verified_shipping_task();


-- ▼▼▼ 20261022083036_daily_shipping_notice.sql ▼▼▼

-- One lightweight candidate query per profile/day. No notice merely from a generated code.
create unique index seller_automatic_notice_day on app.seller_operations(item_id,(payload->>'trade_key'),(payload->>'automatic_day'))
where kind='ship_notice' and payload ? 'automatic_day';

create function app.extension_daily_shipping_candidates(p_account_ids text[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if cardinality(p_account_ids) not between 1 and 4 or exists(select 1 from unnest(p_account_ids) a where a not in ('mercari-1','mercari-2','auctions-1','auctions-2') or a is null) then raise exception '対象アカウントを確認してください';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (
 select i.id item_id,i.sku inventory_sku,i.updated_at expected_updated_at,l.channel,l.account_id,l.external_id,l.trade_key,
 coalesce(l.trade_url,l.url) url,p.result->'shipping_receipt' receipt,p.payload
 from app.items i join app.seller_listings l on l.item_id=i.id and l.active and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key
 join lateral(select o.payload,o.result from app.seller_operations o where o.item_id=i.id and o.account_id=l.account_id and o.channel=l.channel
  and o.kind in ('shipping_code','register_package') and o.status='succeeded' and o.payload->>'trade_key'=l.trade_key order by o.created_at desc limit 1) p on true
 where l.account_id=any(p_account_ids) and i.status='取引中' and i.sold_on is null and i.seller_cancelled_at is null
 and l.trade_key ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}'
 and not exists(select 1 from app.seller_operations o where o.item_id=i.id and (o.status in ('queued','running','uncertain')
  or o.kind='ship_notice' and o.payload->>'trade_key'=l.trade_key and (o.status='succeeded' and o.result->>'notified'='true'
  or o.payload->>'automatic_day'=((now() at time zone 'Asia/Tokyo')::date)::text)))
 order by i.id limit 50) q),'[]'::jsonb);
end $$;

create function app.extension_claim_daily_shipping_notice(p_item_id uuid,p_trade_key text,p_expected_updated_at timestamptz,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;l app.seller_listings;o app.seller_operations;source text;accepted timestamptz;observed timestamptz;trade_day date;day text:=(clock_timestamp() at time zone 'Asia/Tokyo')::date::text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>2000 then raise exception '発送根拠を確認してください';end if;
 select * into i from app.items where id=p_item_id for update;
 select * into l from app.seller_listings where item_id=i.id and active;
 if i.id is null or i.status<>'取引中' or i.sold_on is not null or i.seller_cancelled_at is not null or i.updated_at is distinct from p_expected_updated_at
 or l.id is null or l.channel<>i.sales_channel or l.trade_key is distinct from p_trade_key or i.seller_trade_key is distinct from p_trade_key then return null;end if;
 if not exists(select 1 from app.seller_operations p where p.item_id=i.id and p.kind in ('shipping_code','register_package') and p.status='succeeded'
  and p.account_id=l.account_id and p.channel=l.channel and p.payload->>'trade_key'=p_trade_key) then return null;end if;
 if exists(select 1 from app.seller_operations p where p.item_id=i.id and (p.status in ('queued','running','uncertain')
  or p.kind='ship_notice' and p.payload->>'trade_key'=p_trade_key and (p.status='succeeded' and p.result->>'notified'='true' or p.payload->>'automatic_day'=day))) then return null;end if;
 begin observed:=(p_proof->>'observed_at')::timestamptz;exception when others then return null;end;
 if observed is null or observed<clock_timestamp()-interval '5 minutes' or observed>clock_timestamp()+interval '30 seconds' then return null;end if;
 if p_proof->>'already_notified' is distinct from 'true' then
  source:=p_proof->>'source';
  if p_proof->>'accepted' is distinct from 'true' or coalesce(p_proof->>'tracking_number','')!~'^[0-9]{11,13}$'
   or not ((p_proof->>'carrier'='yamato' and source='https://toi.kuronekoyamato.co.jp/cgi-bin/tneko')
   or (p_proof->>'carrier'='japanpost' and source='https://trackings.post.japanpost.jp/services/srv/search')) then return null;end if;
  begin accepted:=(p_proof->>'accepted_at')::timestamptz;trade_day:=substring(p_trade_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})')::date;exception when others then return null;end;
  if accepted is null or trade_day is null or (accepted at time zone 'Asia/Tokyo')::date<trade_day or accepted>clock_timestamp() or accepted<clock_timestamp()-interval '90 days' then return null;end if;
 end if;
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,claimed_at)
 values(gen_random_uuid(),i.id,app.current_staff_id(),'ship_notice',l.channel,l.account_id,i.status,i.updated_at,
 jsonb_build_object('trade_key',p_trade_key,'automatic_day',day,'automatic_receipt',p_proof),'running',clock_timestamp()) returning * into o;
 return to_jsonb(o)||jsonb_build_object('external_id',l.external_id,'trade_key',l.trade_key,'url',coalesce(l.trade_url,l.url));
end $$;
revoke all on function app.extension_daily_shipping_candidates(text[]),app.extension_claim_daily_shipping_notice(uuid,text,timestamptz,jsonb) from public,anon;
grant execute on function app.extension_daily_shipping_candidates(text[]),app.extension_claim_daily_shipping_notice(uuid,text,timestamptz,jsonb) to authenticated;



-- ▼▼▼ 20261022110000_transfer_confirmed_bundled_remotes.sql ▼▼▼

-- The eight vendor instructions always separate the remote.
-- Move a separately registered accessory, otherwise register the bundled remote.
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare previous_channel app.sales_channel; existing_spare boolean;
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 select sales_channel into previous_channel from app.items where id=new.item_id for update;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  if new.task_kind in ('Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
                       'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク')
   and exists(select 1 from app.items body where body.id=new.item_id and not body.is_accessory) then
   select exists(select 1 from app.spare_accessories s join app.items body on body.id=new.item_id
    where lower(btrim(s.usage_note))=lower(app.product_serial(body.sku,body.lot_seq)) and s.title ilike '%リモコン%') into existing_spare;
   -- Transfer before the body update can synchronize the accessory SKU.
   perform app.prepare_yahoo_auction_item(new.item_id);
   -- Preserve the explicit fault report on a newly registered, bundled (zero extra cost) remote.
   if not existing_spare and exists(select 1 from app.items where id=new.item_id
    and malfunction_comment ~ 'リモコン[^。\n]{0,30}(作動しない|動かない|不動|反応しない)') then
    update app.spare_accessories s set title='リモコン（作動しないとの報告あり）'
    from app.items body where body.id=new.item_id and lower(btrim(s.usage_note))=lower(app.product_serial(body.sku,body.lot_seq))
     and s.source_sku is null and s.cost_amount=0 and s.used_for_item_id is null;
   end if;
  end if;
  update app.items set
   workflow_previous_sales_channel=previous_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;


-- ▼▼▼ 20261022112344_purchase_sync_button.sql ▼▼▼

-- Manual purchase history sync requests: authenticated active administrators only.
create table app.purchase_sync_requests (
 request_id uuid not null, profile_id uuid not null, owner_id uuid not null,
 accounts jsonb not null check(jsonb_typeof(accounts)='array'),
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 claim_token uuid, result jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 minutes',
 finished_at timestamptz,
 primary key(request_id,profile_id)
);
create index purchase_sync_requests_owner_latest on app.purchase_sync_requests(owner_id,created_at desc);
alter table app.purchase_sync_requests enable row level security;
revoke all on app.purchase_sync_requests from public,anon,authenticated;
grant select,insert,update on app.purchase_sync_requests to authenticated;
create policy purchase_sync_owner_admin on app.purchase_sync_requests for all to authenticated
 using(owner_id=(select auth.uid()) and (select app.is_admin()) and exists(select 1 from app.staff where id=app.current_staff_id() and is_active))
 with check(owner_id=(select auth.uid()) and (select app.is_admin()) and exists(select 1 from app.staff where id=app.current_staff_id() and is_active));
create function app.purchase_sync(p_action text,p_request_id uuid default null,p_profile_id uuid default null,p_claim_token uuid default null,p_result jsonb default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare target uuid; claimed app.purchase_sync_requests; expected text[]:=array['mercari-1','mercari-2','auctions-1','auctions-2','flea-1','flea-2','rakuma-1']; ids text[]; total integer;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者としてログインしてください' using errcode='42501';end if;
 if p_action='request' then
  if p_request_id is null then raise exception '同期依頼IDが必要です';end if;
  perform pg_advisory_xact_lock(hashtextextended('purchase-sync:'||auth.uid()::text,0));
  select request_id into target from app.purchase_sync_requests where owner_id=auth.uid() and (request_id=p_request_id or (status in ('queued','running') and expires_at>now())) order by created_at desc limit 1;
  if target is null then
   select array_agg(distinct a order by a),count(*) into ids,total from app.marketplace_extension_runtime_status r cross join lateral jsonb_array_elements_text(r.accounts) a
    where r.mode<>'diagnostic' and r.reported_at>now()-interval '7 days' and r.accounts<@to_jsonb(expected);
   if total<>7 or cardinality(ids)<>7 or not ids@>expected then raise exception '7アカウントの拡張機能登録を確認できません。別PCのChromeを開いてください';end if;
   insert into app.purchase_sync_requests(request_id,profile_id,owner_id,accounts)
    select p_request_id,r.profile_id,auth.uid(),r.accounts from app.marketplace_extension_runtime_status r
    where r.mode<>'diagnostic' and r.reported_at>now()-interval '7 days' and r.accounts<@to_jsonb(expected) and jsonb_array_length(r.accounts)>0;
   target:=p_request_id;
  end if;
 elsif p_action='claim' then
  if p_profile_id is null then raise exception '実行プロファイルが必要です';end if;
  select * into claimed from app.purchase_sync_requests where owner_id=auth.uid() and profile_id=p_profile_id and status='queued' and expires_at>now() order by created_at limit 1 for update skip locked;
  if not found then return null;end if;
  update app.purchase_sync_requests set status='running',claim_token=gen_random_uuid() where request_id=claimed.request_id and profile_id=p_profile_id returning * into claimed;
  return jsonb_build_object('requestId',claimed.request_id,'profileId',claimed.profile_id,'accounts',claimed.accounts,'token',claimed.claim_token,'expiresAt',claimed.expires_at);
 elsif p_action='finish' then
  if p_request_id is null or p_profile_id is null or p_claim_token is null or jsonb_typeof(p_result)<>'object' or p_result is null then raise exception '完了記録を確認してください';end if;
  if coalesce(p_result->>'imported','0') !~ '^[0-9]{1,7}$' or coalesce(p_result->>'errors','0') !~ '^[0-9]{1,7}$' then raise exception '件数が不正です';end if;
  update app.purchase_sync_requests set status=case when coalesce((p_result->>'errors')::integer,0)>0 then 'failed' else 'completed' end,
   result=jsonb_build_object('imported',coalesce((p_result->>'imported')::integer,0),'errors',coalesce((p_result->>'errors')::integer,0),'note',left(coalesce(p_result->>'note',''),500)),finished_at=now()
   where owner_id=auth.uid() and request_id=p_request_id and profile_id=p_profile_id and claim_token=p_claim_token and status='running';
  if not found and not exists(select 1 from app.purchase_sync_requests where owner_id=auth.uid() and request_id=p_request_id and profile_id=p_profile_id and claim_token=p_claim_token and status in ('completed','failed')) then raise exception '同期の予約が一致しません';end if;
  target:=p_request_id;
 elsif p_action='status' then
  target:=p_request_id;
  if target is null then select request_id into target from app.purchase_sync_requests where owner_id=auth.uid() order by created_at desc limit 1;end if;
 else raise exception '同期操作が不正です';end if;
 return jsonb_build_object('requestId',target,'profiles',coalesce((select jsonb_agg(jsonb_build_object('profileId',profile_id,'accounts',accounts,'status',case when status in ('queued','running') and expires_at<=now() then 'expired' else status end,'result',result,'createdAt',created_at,'expiresAt',expires_at,'finishedAt',finished_at) order by profile_id) from app.purchase_sync_requests where owner_id=auth.uid() and request_id=target),'[]'::jsonb));
end $$;
revoke all on function app.purchase_sync(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app.purchase_sync(text,uuid,uuid,uuid,jsonb) to authenticated;


-- ▼▼▼ 20261022115721_purchase_sync_running_deadline.sql ▼▼▼

-- Queued requests still expire after 30 minutes. Accepted scans may need more
-- time because existing pacing and per-item purchase-date checks are preserved.
do $$ declare definition text; old_text text:='set status=''running'',claim_token=gen_random_uuid()'; begin
 definition:=pg_get_functiondef('app.purchase_sync(text,uuid,uuid,uuid,jsonb)'::regprocedure);
 if position(old_text in definition)=0 then raise exception 'Purchase sync claim definition changed';end if;
 execute replace(definition,old_text,old_text||',expires_at=now()+interval ''2 hours''');
end $$;
update app.purchase_sync_requests set expires_at=greatest(expires_at,created_at+interval '2 hours') where status='running';


-- ▼▼▼ 20261022122000_daily_sales_summary.sql ▼▼▼

-- Preserve the chart's serial grouping and financial-family counts under caller RLS.
create function app.read_daily_sales_summary(p_from date,p_to date) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from+1>36600 then raise exception '開始日・終了日を確認してください。期間は100年以内で指定してください。' using errcode='22023';end if;
 with rows as materialized (
  select s.*,upper(coalesce(substring(s.sku from '^([0-9]+[a-zA-Z]*)[-_]'),s.lot_seq::text)) chart_serial
  from app.v_financial_sales s
 ), sales as (
  select * from rows where sold_on is not null and (nullif(family_key,'') is not null
   or not(is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))
 ), grouped as (
  select chart_serial,(array_agg(family_key order by id))[1] family,
   count(distinct jsonb_build_array(sold_on,sold_price,payout_amount))>1 or bool_or(sold_price is null) conflict
  from sales group by chart_serial
 ), chosen as (
  select distinct on(chart_serial) chart_serial,sold_on,sold_price from sales
  order by chart_serial,is_accessory,id
 ), totals as (
  select c.sold_on,sum(coalesce(c.sold_price,0)) amount,count(distinct coalesce(g.family,g.chart_serial)) count
  from chosen c join grouped g using(chart_serial)
  where not g.conflict and c.sold_on between p_from and p_to group by c.sold_on
 ), days as (
  select d::date date,coalesce(t.amount,0) amount,coalesce(t.count,0) count
  from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d left join totals t on t.sold_on=d::date
 ), conflicts as (
  select g.chart_serial from grouped g where g.conflict and exists(select 1 from sales s
   where s.chart_serial=g.chart_serial and s.sold_on between p_from and p_to)
 )
 select jsonb_build_object('days',(select jsonb_agg(to_jsonb(d) order by d.date) from days d),
  'conflicts',coalesce((select jsonb_agg(chart_serial order by chart_serial) from conflicts),'[]'::jsonb)) into result;
 return result;
end $$;
revoke all on function app.read_daily_sales_summary(date,date) from public,anon;
grant execute on function app.read_daily_sales_summary(date,date) to authenticated;


-- ▼▼▼ 20261023130325_admin_task_completion_sync.sql ▼▼▼

-- A completed current sale is evidence that its shipping reminder is no longer actionable.
-- A sold date alone, an old trade, or an uncertain notification is not completion evidence.
create function app.current_trade_completed(p_item_id uuid) returns boolean
language sql stable security invoker set search_path=pg_catalog,app as $$
 select exists(select 1 from app.items i join app.seller_listings l on l.item_id=i.id
  where i.id=p_item_id and i.status='販売済' and i.seller_cancelled_at is null
   and i.sold_on is not null and i.sold_price is not null and i.payout_amount is not null
   and l.active and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key
   and nullif(l.trade_key,'') is not null and l.observed_status='販売済'
   and l.verified_sale @> jsonb_build_object('sold_on',i.sold_on,'sold_price',i.sold_price,'payout_amount',i.payout_amount));
$$;
revoke all on function app.current_trade_completed(uuid) from public,anon;
grant execute on function app.current_trade_completed(uuid) to authenticated,service_role;

create function app.close_completed_trade_shipping_tasks() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if app.current_trade_completed(new.item_id) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp()
  where item_id=new.item_id and resolved_at is null;
 end if;
 return new;
end $$;
revoke all on function app.close_completed_trade_shipping_tasks() from public,anon,authenticated;
create trigger seller_listings_close_completed_trade_shipping_tasks
 after insert or update of active,trade_key,observed_status,verified_sale on app.seller_listings
 for each row execute function app.close_completed_trade_shipping_tasks();

do $migration$
declare original text; patched text;
begin
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'where t.resolved_at is null and t.created_at<=now()',
  'where t.resolved_at is null and not app.current_trade_completed(i.id) and t.created_at<=now()');
 if patched=original then raise exception 'Shipping task snapshot anchor changed';end if;
 execute patched;
end $migration$;

-- Retain all history and business dates; only resolve tasks supported by current sale evidence.
update app.delivery_shipping_tasks t set resolved_at=clock_timestamp()
where t.resolved_at is null and app.current_trade_completed(t.item_id);
notify pgrst,'reload schema';


-- ▼▼▼ 20261024021840_line_shipping_notifications.sql ▼▼▼

-- LINE identifiers and one-time link codes are never exposed through Data API.
create table app.delivery_line_links (
 id uuid not null unique default gen_random_uuid(),
 staff_id uuid primary key references app.staff(id) on delete cascade,
 line_user_id text not null unique check(line_user_id ~ '^U[0-9a-f]{32}$'),
 linked_at timestamptz not null default now(),blocked boolean not null default false
);
create table app.delivery_line_codes (
 staff_id uuid primary key references app.staff(id) on delete cascade,
 code_hash text not null unique check(code_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),expires_at timestamptz not null
);
create table app.delivery_line_webhooks (
 event_id text primary key,created_at timestamptz not null default now()
);
create table app.delivery_line_settings (
 singleton boolean primary key default true check(singleton),enabled boolean not null default false
);
insert into app.delivery_line_settings default values;
create table app.delivery_line_outbox (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references app.delivery_shipping_tasks(id) on delete cascade,
 link_id uuid not null references app.delivery_line_links(id) on delete cascade,
 trade_key text,
 created_at timestamptz not null default now(),
 state text not null default 'pending' check(state in ('pending','sending','sent','cancelled','failed')),
 attempts integer not null default 0,next_attempt_at timestamptz not null default now(),
 first_attempt_at timestamptz,sent_at timestamptz,last_status integer,lease uuid,
 payload jsonb,unique(task_id,link_id)
);
create index delivery_line_outbox_pending on app.delivery_line_outbox(next_attempt_at) where state in ('pending','sending');
create index delivery_line_outbox_link on app.delivery_line_outbox(link_id);
alter table app.delivery_line_links enable row level security;
alter table app.delivery_line_codes enable row level security;
alter table app.delivery_line_webhooks enable row level security;
alter table app.delivery_line_settings enable row level security;
alter table app.delivery_line_outbox enable row level security;
revoke all on app.delivery_line_links,app.delivery_line_codes,app.delivery_line_webhooks,app.delivery_line_settings,app.delivery_line_outbox from public,anon,authenticated;
grant all on app.delivery_line_links,app.delivery_line_codes,app.delivery_line_webhooks,app.delivery_line_settings,app.delivery_line_outbox to service_role;

-- Service-only RPCs: the Edge Function validates Auth.getUser and active staff.
-- Atomic issuance prevents concurrent requests from bypassing the per-staff limit.
create function app.issue_delivery_line_code(p_staff uuid,p_hash text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_staff::text,17351));
 if not exists(select 1 from app.staff where id=p_staff and is_active and role in ('admin','deliverer')) then raise exception 'Invalid staff';end if;
 if exists(select 1 from app.delivery_line_codes where staff_id=p_staff and created_at>now()-interval '1 minute') then raise exception 'Please wait one minute';end if;
 insert into app.delivery_line_codes(staff_id,code_hash,expires_at) values(p_staff,p_hash,now()+interval '10 minutes')
 on conflict(staff_id) do update set code_hash=excluded.code_hash,created_at=now(),expires_at=excluded.expires_at;
end $$;

-- Serialize link/unfollow operations. Replayed webhook events cannot consume a
-- fresh code or replace a later binding. Never transfer another staff's LINE.
create function app.handle_delivery_line_event(p_event text,p_kind text,p_user text,p_hash text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
 perform pg_advisory_xact_lock(173511019);
 if p_user !~ '^U[0-9a-f]{32}$' or length(p_event)>128 or p_kind not in ('link','unfollow') then return false;end if;
 insert into app.delivery_line_webhooks(event_id) values(p_event) on conflict do nothing;
 if not found then return false;end if;
 delete from app.delivery_line_webhooks where created_at<now()-interval '7 days';
 delete from app.delivery_line_codes where expires_at<now();
 if p_kind='unfollow' then
  update app.delivery_line_links set blocked=true where line_user_id=p_user;
  update app.delivery_line_outbox o set state='cancelled' from app.delivery_line_links l
   where o.link_id=l.id and l.line_user_id=p_user and o.state in ('pending','sending');
  return false;
 end if;
 select c.staff_id into target from app.delivery_line_codes c join app.staff s on s.id=c.staff_id
  where c.code_hash=p_hash and c.expires_at>now() and s.is_active and s.role in ('admin','deliverer') for update of c;
 if target is null or exists(select 1 from app.delivery_line_links where line_user_id=p_user and staff_id<>target) then return false;end if;
 -- A new generation cancels old pending messages, including retries to an old LINE.
 delete from app.delivery_line_links where staff_id=target;
 insert into app.delivery_line_links(staff_id,line_user_id) values(target,p_user);
 delete from app.delivery_line_codes where staff_id=target;
 return true;
end $$;

create function app.unlink_delivery_line(p_staff uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(173511019);
 delete from app.delivery_line_codes where staff_id=p_staff;
 delete from app.delivery_line_links where staff_id=p_staff;
end $$;

-- Only future tasks and actual staff reassignment enqueue. Registration does not
-- broadcast historical requests. No marketplace polling is added.
create function app.capture_delivery_line_shipping() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='delivery_shipping_tasks' then
  insert into app.delivery_line_outbox(task_id,link_id,trade_key)
  select new.id,l.id,i.seller_trade_key from app.items i join app.delivery_line_links l on l.staff_id=i.deliverer_id
  join app.staff s on s.id=l.staff_id and s.is_active
  where i.id=new.item_id and not l.blocked and new.resolved_at is null
   and (select enabled from app.delivery_line_settings where singleton)
  on conflict do nothing;
 elsif new.deliverer_id is distinct from old.deliverer_id then
  insert into app.delivery_line_outbox(task_id,link_id,trade_key)
  select t.id,l.id,new.seller_trade_key from app.delivery_shipping_tasks t
   join app.delivery_line_links l on l.staff_id=new.deliverer_id and not l.blocked
   join app.staff s on s.id=l.staff_id and s.is_active
  where t.item_id=new.id and t.resolved_at is null and (select enabled from app.delivery_line_settings where singleton)
  on conflict do nothing;
 end if;
 return new;
end $$;
create trigger delivery_shipping_tasks_line after insert on app.delivery_shipping_tasks for each row execute function app.capture_delivery_line_shipping();
create trigger items_line_reassignment after update of deliverer_id on app.items for each row execute function app.capture_delivery_line_shipping();

create function app.claim_delivery_line() returns table(id uuid,lease uuid,recipient text,payload jsonb,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return;end if;
 update app.delivery_line_outbox o set state='failed' where o.state in ('pending','sending')
  and o.next_attempt_at<=now() and (o.attempts>=5 or o.created_at<now()-interval '23 hours');
 return query with ready as (
  select o.id from app.delivery_line_outbox o where o.state in ('pending','sending')
   and o.next_attempt_at<=now() and o.attempts<5 and o.created_at>now()-interval '23 hours'
  order by o.next_attempt_at limit 5 for update skip locked
 ), claimed as (
  update app.delivery_line_outbox o set state='sending',attempts=o.attempts+1,
   first_attempt_at=coalesce(o.first_attempt_at,now()),next_attempt_at=now()+interval '5 minutes',lease=gen_random_uuid(),
   payload=coalesce(o.payload,jsonb_build_object('itemId',i.id,'sku',i.sku,'serial',split_part(i.sku,'-',1)))
  from ready r,app.delivery_shipping_tasks t,app.items i where o.id=r.id and t.id=o.task_id and i.id=t.item_id returning o.*
 ) select o.id,o.lease,l.line_user_id,o.payload,
  not l.blocked and s.is_active and s.id=i.deliverer_id and l.linked_at<=o.created_at
  and t.resolved_at is null and i.status='取引中' and i.shipped_on is null
  and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
  and i.seller_trade_key is not distinct from o.trade_key
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=s.id and c.item_id=i.id and c.notice_id='shipping:'||t.id::text)
 from claimed o join app.delivery_line_links l on l.id=o.link_id join app.staff s on s.id=l.staff_id
 join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id;
end $$;
create function app.finish_delivery_line(p_id uuid,p_lease uuid,p_state text,p_status integer) returns void
language sql security definer set search_path='' as $$
 update app.delivery_line_outbox set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
 last_status=p_status,sent_at=case when p_state='sent' then now() else sent_at end,next_attempt_at=now()+interval '5 minutes'
 where id=p_id and lease=p_lease and state='sending' and p_state in ('pending','sent','cancelled','failed');
$$;
-- Reuse the existing private dispatcher token. No network request when no queue.
create function app.kick_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text;project_url text;request_id bigint;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) or not exists(
  select 1 from app.delivery_line_outbox where state in ('pending','sending') and next_attempt_at<=now()
 ) then return null;end if;
 select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
 select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
 if dispatch_token is null or project_url is null then return null;end if;
 select net.http_post(url:=project_url||'/functions/v1/delivery-line',
  headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
  body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=50000) into request_id;
 return request_id;
end $$;
revoke all on function app.issue_delivery_line_code(uuid,text),app.handle_delivery_line_event(text,text,text,text),app.capture_delivery_line_shipping(),app.claim_delivery_line(),app.finish_delivery_line(uuid,uuid,text,integer),app.kick_delivery_line() from public,anon,authenticated;
grant execute on function app.issue_delivery_line_code(uuid,text),app.handle_delivery_line_event(text,text,text,text),app.claim_delivery_line(),app.finish_delivery_line(uuid,uuid,text,integer),app.kick_delivery_line() to service_role;
revoke all on function app.unlink_delivery_line(uuid) from public,anon,authenticated;
grant execute on function app.unlink_delivery_line(uuid) to service_role;
select cron.schedule('delivery-line-shipping','* * * * *','select app.kick_delivery_line();');
notify pgrst,'reload schema';


-- ▼▼▼ 20261024062428_automatic_line_shipping.sql ▼▼▼

-- Settings are saved once per product. Missing media/settings hold the request;
-- they never select another product's picture or guess a shipping location.
create table app.delivery_line_preferences (
 item_id uuid primary key references app.items(id) on delete cascade,
 overview_photo_id uuid references app.item_photos(id) on delete set null,
 model_photo_id uuid references app.item_photos(id) on delete set null,
 shipping jsonb not null default '{}'::jsonb,updated_at timestamptz not null default now()
);
create index delivery_line_preferences_overview on app.delivery_line_preferences(overview_photo_id);
create index delivery_line_preferences_model on app.delivery_line_preferences(model_photo_id);
alter table app.delivery_line_preferences enable row level security;
revoke all on app.delivery_line_preferences from public,anon,authenticated;
grant all on app.delivery_line_preferences to service_role;
grant select on app.delivery_line_preferences to authenticated;
create policy delivery_line_preferences_read on app.delivery_line_preferences for select to authenticated using (
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id()))
);
alter table app.delivery_line_outbox add column message_payload jsonb,add column last_error text;
alter table app.delivery_line_outbox add column code_cleaned_at timestamptz;
create index delivery_line_media_cleanup on app.delivery_line_outbox(next_attempt_at) where code_cleaned_at is null and state in ('sent','cancelled','failed');
insert into storage.buckets(id,name,public) values('line-shipping-codes','line-shipping-codes',false) on conflict(id) do nothing;

create function app.save_line_shipping_preferences(p_item_id uuid,p_overview uuid,p_model uuid,p_shipping jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare i app.items;photo uuid;source app.items;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id;
 if i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then raise exception '担当商品のみ設定できます' using errcode='42501';end if;
 if jsonb_typeof(p_shipping) is distinct from 'object' or octet_length(p_shipping::text)>1000
  or exists(select 1 from jsonb_object_keys(p_shipping) k where k not in ('shippingMethod','size','dropoff','weightKg','category')) then raise exception '配送設定を確認してください';end if;
 if p_shipping ? 'size' and coalesce(p_shipping->>'size','') not in ('','100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') then raise exception '配送サイズを確認してください';end if;
 if p_shipping ? 'dropoff' and coalesce(p_shipping->>'dropoff','') not in ('','セブンイレブン','ヤマト営業所','ローソン','郵便局') then raise exception '発送場所を確認してください';end if;
 foreach photo in array array[p_overview,p_model] loop
  if photo is null then continue;end if;
  select s.* into source from app.item_photos p join app.items s on s.id=p.item_id
   where p.id=photo and coalesce(p.photo_kind,'product')='product'
    and (p.storage_path not like '%/reflected-%' or p.item_id=i.id);
  if source.id is null or lower(app.product_serial(source.sku,source.lot_seq)) is distinct from lower(app.product_serial(i.sku,i.lot_seq)) then raise exception 'この商品の商品写真を選択してください';end if;
 end loop;
 insert into app.delivery_line_preferences(item_id,overview_photo_id,model_photo_id,shipping)
 values(i.id,p_overview,p_model,p_shipping) on conflict(item_id) do update
 set overview_photo_id=excluded.overview_photo_id,model_photo_id=excluded.model_photo_id,shipping=excluded.shipping,updated_at=now();
 perform app.kick_delivery_line();
end $$;

-- Same model-keyed catalog as packages/shared/src/productCategory.ts.
-- Large categories have a fixed size even before any shipping operation exists.
create function app.line_model_shipping_size(p_model text,p_title text) returns text
language sql immutable set search_path='' as $model$
 with catalog as (select key,value from jsonb_each_text('{"DMR-BRX2030":"100","DMR-BRX2050":"100","DMR-BRX2060":"100","DMR-BRZ1020":"100","DMR-BRG1030":"100","DMR-BRG2030":"100","DMR-BRG2050":"100","DMR-BRW550":"100","DMR-BRW1020":"100","DMR-BRW1050":"100","DMR-BRW1060":"100","DMR-BRW2060":"100","DMR-BRT530":"100","DMR-BRT1030":"100","DMR-BCW560":"100","DMR-BCW1060":"100","DMR-BCX2060":"100","DMR-SCZ2060":"100","DMR-UBX4030":"100","DMR-UBX4050":"100","DMR-UBX7050":"100","DMR-UBZ1020":"100","DMR-UBZ1030":"100","DMR-UBZ2020":"100","DMR-UBZ2030":"100","DMR-UCX4060":"100","DMR-UCX8060":"100","DMR-BRT1060":"100","DMR-BCT1060":"100","DMR-BCT2060":"100","DMR-UX4050":"100","DMR-UX7030":"100","DMR-UX7050":"100","DMR-BG2050":"100","DMR-BX2030":"100","DMR-BX2050":"100","DMR-BW1050":"100","DMR-4S100":"100","DMR-2W50":"100","DMR-2W51":"100","DMR-2W100":"100","DMR-2W101":"100","DMR-2W102":"100","DMR-2W103":"100","DMR-2W200":"100","DMR-2W201":"100","DMR-2W202":"100","DMR-2W203":"100","DMR-4W100":"100","DMR-4W101":"100","DMR-4W102":"100","DMR-4W200":"100","DMR-4W201":"100","DMR-4W202":"100","DMR-4W300":"100","DMR-2X200":"100","DMR-2X202":"100","DMR-2X203":"100","DMR-2X301":"100","DMR-2X302":"100","DMR-2X303":"100","DMR-2X602":"100","DMR-2X603":"100","DMR-4X403":"100","DMR-4X600":"100","DMR-4X602":"100","DMR-4X1002":"100","DMR-4X1003":"100","DMR-2T101":"100","DMR-4T103":"100","DMR-4T201":"100","DMR-4T202":"100","DMR-4T203":"100","DMR-4T302":"100","DMR-4T303":"100","DMR-4T402":"100","DMR-4T403":"100","DMR-4SE102":"100","DMR-4CS100":"100","DMR-2CW100":"100","DMR-2CW200":"100","DMR-4CW200":"100","DMR-4CW201":"100","DMR-2CX200":"100","DMR-2CT101":"100","DMR-4TS203":"100","DMR-4TS204":"100","DMR-4TS204S":"100","DMR-ZR1":"100","DP-UB45":"100","DP-UB45S":"100","TU-BUHD100":"100","BDZ-ZW550":"100","BDZ-ZW1500":"100","BDZ-ZW1700":"100","BDZ-ZW1800":"100","BDZ-ZW1900":"100","BDZ-ZW2500":"100","BDZ-ZW2700":"100","BDZ-ZW2800":"100","BDZ-ZT1500":"100","BDZ-ZT1700":"100","BDZ-ZT1800":"100","BDZ-ZT2000":"100","BDZ-ZT2500":"100","BDZ-ZT2800":"100","BDZ-ZT3500":"100","BDZ-FW500":"100","BDZ-FW1000":"100","BDZ-FW2000":"100","BDZ-FT1000":"100","BDZ-FT2000":"100","BDZ-FT3000":"100","BDZ-FBW1000":"100","BDZ-FBW1100":"100","BDZ-FBW2000":"100","BDZ-FBW2100":"100","BDZ-FBW2200":"100","BDZ-FBT1000":"100","BDZ-FBT2000":"100","BDZ-FBT2100":"100","BDZ-FBT2200":"100","BDZ-FBT3000":"100","BDZ-FBT4000":"100","BDZ-FBT4100":"100","BDZ-FBT4200":"100","BDZ-FBT6100":"100","BDP-S1700":"100","BDP-S6700":"100","UBP-X700":"100","BD-UT1200":"100","BD-UT2100":"100","BD-UT2200":"100","BD-NW1200":"100","BD-NW2100":"100","BD-NW2200":"100","BD-WW1200":"100","BD-NT1200":"100","BD-NT2200":"100","4B-C20AT3":"100","4B-C40AT3":"100","2B-C05BW1":"100","2B-C10BW1":"100","2B-C20BW1":"100","2B-C10BW2":"100","2B-C10BT1":"100","2B-C10BT3":"100","2B-C20BT3":"100","4B-C10BT3":"100","4B-C20BT3":"100","4B-C40BT3":"100","2B-C05CW1":"100","2B-C10CW1":"100","2B-C20CW1":"100","2B-C30CW1":"100","2B-C10CW2":"100","2B-C10CT1":"100","2B-C20CT1":"100","2B-C10CT4":"100","2B-C05DW1":"100","2B-C10DW1":"100","2B-C20DW1":"100","2B-C10DW2":"100","2B-C30DW1":"100","4B-C10DW3":"100","4B-C20DW3":"100","4B-C30DW3":"100","2B-C10DT1":"100","2B-C20DT1":"100","4B-C20DT3":"100","4B-C30DT3":"100","4B-C40DT3":"100","2B-C05EW1":"100","2B-C10EW1":"100","2B-C20EW1":"100","2B-C10EW2":"100","2B-C10ET1":"100","2B-C20ET1":"100","4B-C10EW3":"100","4B-C20EW3":"100","4B-C40EW3":"100","4B-C20ET3":"100","4B-C40ET3":"100","4B-C60ET3":"100","2B-C10GW1":"100","2B-C20GW1":"100","2B-C20GT1":"100","4B-C20GT3":"100","4B-C40GT3":"100","DBR-UT109":"100","DBR-UT209":"100","DBR-M2008":"100","DBR-M3009":"100","DBR-M3010":"100","DBR-M4008":"100","DBR-M4010":"100","DBR-4KZ200":"100","DBR-4KZ400":"100","DBR-4KZ600":"100","DBR-W508":"100","DBR-W509":"100","DBR-W1007":"100","DBR-W1008":"100","DBR-W1009":"100","DBR-W1010":"100","DBR-T1007":"100","DBR-T1008":"100","DBR-T1009":"100","DBR-T1010":"100","DBR-W2007":"100","DBR-W2008":"100","DBR-W2009":"100","DBR-W2010":"100","DBR-T2008":"100","DBR-T2010":"100","DBR-T3007":"100","DBR-T3008":"100","TT-4K100":"100","VZ239HR":"140","VG249Q1A":"140","PA248QV":"140","PA247CV":"140","PA278QV":"140","PA278CV":"140","EW3270U":"140","GW2283":"140","BENQ GL2780":"140","EW2880U":"140","PD3205U":"140","PD2705U":"140","SW272U":"140","XL2546":"140","EL2870U":"140","GW2780":"140","EW3280U":"140","PD2705Q":"140","XL2546K":"140","XL2411K":"140","EX2510S":"140","EX2710S":"140","XL2746K":"140","EX3210R":"140","EX2710U":"140","EX240N":"140","EX270QM":"140","XL2566K":"140","XL2546X":"140","P2418HT":"140","U2720QM":"140","AW2521HF":"140","S2721HS":"140","S2721DS":"140","S3221QS":"140","S2721QS":"140","S2721DGF":"140","C2422HE":"140","U2422H":"140","U2722DE":"140","U2422HE":"140","S2522HG":"140","S2722DC":"140","S2722QC":"140","C1422H":"140","U3223QE":"140","U2723QX":"140","G3223Q":"140","AW2523HF":"140","G2524H":"140","24UD58":"140","29UM69G":"140","UBK90":"140","27UL850":"140","27UL500":"140","32ML600M":"140","27GL850":"140","27GL650F":"140","29WL500":"140","27MD5KL":"140","27EA430V":"140","24MD4KL":"140","27ML600S":"140","24ML600S":"140","29WN600":"140","27GN950":"140","32UN650":"140","32UN500":"140","27GN600":"140","27UP850":"140","24QP750":"140","27QN880":"140","29WP500":"140","27QN600":"140","32GN600":"140","16MQ70":"140","32UP550N":"140","28MQ750":"140","27GR75Q":"140","32SR50F":"140","27SR50F":"140","32SR83U":"140","32SR73U":"140"}'::jsonb)),
 normalized as (select btrim(regexp_replace(translate(upper(normalize(coalesce(p_model,''),NFKC)),'‐‑‒–—−ー','-------'),'\s+',' ','g')) model,
 btrim(regexp_replace(translate(upper(normalize(coalesce(p_title,''),NFKC)),'‐‑‒–—−ー','-------'),'\s+',' ','g')) title)
 select case when n.model<>'' then (select value from catalog where key=n.model)
 else (select c.value from catalog c where strpos(n.title,c.key)>0
  and substring(n.title from greatest(1,strpos(n.title,c.key)-1) for case when strpos(n.title,c.key)=1 then 0 else 1 end) !~ '[A-Z0-9]'
  and substring(n.title from strpos(n.title,c.key)+length(c.key) for 1) !~ '[A-Z0-9]'
  order by length(c.key) desc limit 1) end from normalized n;
$model$;
create function app.line_fixed_shipping_size(p_item_id uuid) returns text
language sql stable set search_path='' as $$
 select case when not i.is_accessory then app.line_model_shipping_size(p.model_no,i.title) end
 from app.items i left join app.products p on p.id=i.product_id where i.id=p_item_id;
$$;
revoke all on function app.line_model_shipping_size(text,text),app.line_fixed_shipping_size(uuid) from public,anon;
grant execute on function app.line_model_shipping_size(text,text),app.line_fixed_shipping_size(uuid) to authenticated,service_role;

-- Small goods learn from a completed shipment of the same ASIN or maker/model.
-- Only size is shared: no customer, recipient, LINE ID or supplier data.
create table app.delivery_line_size_history (
 product_key text primary key,size text not null check(size in ('100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット')),
 shipped_on date not null,updated_at timestamptz not null default now()
);
alter table app.delivery_line_size_history enable row level security;
revoke all on app.delivery_line_size_history from public,anon,authenticated;
grant select on app.delivery_line_size_history to authenticated;
grant all on app.delivery_line_size_history to service_role;
create policy delivery_line_size_history_read on app.delivery_line_size_history for select to authenticated using(
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
);
create function app.line_small_product_key(p_item_id uuid) returns text
language sql stable set search_path='' as $$
 select case when upper(coalesce(nullif(i.asin,''),p.asin,'')) ~ '^[A-Z0-9]{10}$'
 then 'asin:'||upper(coalesce(nullif(i.asin,''),p.asin))
 when nullif(btrim(p.model_no),'') is not null and nullif(btrim(p.maker),'') is not null
 then 'model:'||jsonb_build_array(upper(normalize(btrim(p.maker),NFKC)),upper(normalize(btrim(p.model_no),NFKC)))::text end
 from app.items i left join app.products p on p.id=i.product_id where i.id=p_item_id and app.line_fixed_shipping_size(i.id) is null;
$$;
create function app.line_learned_shipping_size(p_item_id uuid) returns text
language sql stable set search_path='' as $$
 select h.size from app.delivery_line_size_history h where h.product_key=app.line_small_product_key(p_item_id);
$$;
create function app.remember_line_shipping_size(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare i app.items;product text;actual_size text;
begin
 select * into i from app.items where id=p_item_id;
 if i.shipped_on is null or i.seller_cancelled_at is not null then return;end if;
 product:=app.line_small_product_key(i.id);if product is null then return;end if;
 select o.payload->>'size' into actual_size from app.seller_operations o
 where o.item_id=i.id and o.status='succeeded' and o.kind in ('shipping_code','register_package')
 and o.payload->>'trade_key'=i.seller_trade_key order by o.created_at desc limit 1;
 actual_size:=coalesce(nullif(actual_size,''),(select nullif(shipping->>'size','') from app.delivery_line_preferences where item_id=i.id));
 if actual_size not in ('100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') or actual_size is null then return;end if;
 insert into app.delivery_line_size_history(product_key,size,shipped_on) values(product,actual_size,i.shipped_on)
 on conflict(product_key) do update set size=excluded.size,shipped_on=excluded.shipped_on,updated_at=now()
 where excluded.shipped_on>=app.delivery_line_size_history.shipped_on;
end $$;
create function app.capture_line_shipping_size() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.shipped_on is not null and new.shipped_on is distinct from old.shipped_on then perform app.remember_line_shipping_size(new.id);end if;
 return new;
end $$;
create trigger line_learn_shipping_size after update of shipped_on on app.items for each row execute function app.capture_line_shipping_size();
-- Learn existing verified shipments without issuing codes or sending old requests.
do $$declare shipped_item record;begin
 for shipped_item in select distinct item_id from app.seller_operations o join app.items i on i.id=o.item_id
 where o.kind in ('shipping_code','register_package') and o.status='succeeded' and i.shipped_on is not null
 and nullif(o.payload->>'size','') is not null order by item_id loop perform app.remember_line_shipping_size(shipped_item.item_id);end loop;
end $$;
revoke all on function app.line_small_product_key(uuid),app.line_learned_shipping_size(uuid) from public,anon;
grant execute on function app.line_small_product_key(uuid),app.line_learned_shipping_size(uuid) to authenticated,service_role;
revoke all on function app.remember_line_shipping_size(uuid),app.capture_line_shipping_size() from public,anon,authenticated;
grant execute on function app.remember_line_shipping_size(uuid) to service_role;

-- The existing shipping panel shows the same saved per-product defaults used
-- by automatic acquisition. Read access above is restricted to its assignee.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 patched:=replace(original,'''category'',s.p->''category''))','''category'',s.p->''category'')) || coalesce((select shipping from app.delivery_line_preferences where item_id=i.id),''{}''::jsonb) || case when app.line_fixed_shipping_size(i.id) is not null then jsonb_build_object(''size'',app.line_fixed_shipping_size(i.id)) when nullif(coalesce((select shipping->>''size'' from app.delivery_line_preferences where item_id=i.id),s.p->>''size''),'''') is null and app.line_learned_shipping_size(i.id) is not null then jsonb_build_object(''size'',app.line_learned_shipping_size(i.id)) else ''{}''::jsonb end');
 if patched=original then raise exception 'Shipping defaults anchor missing';end if;
 execute patched;
end $patch$;
-- Server media preparation reads existing data, without granting any writes.
grant select on app.items,app.products,app.staff,app.profiles,app.item_photos,app.seller_listings,app.seller_operations,app.delivery_shipping_tasks,app.delivery_notice_completions to service_role;

create function app.line_shipping_eligible(p_id uuid) returns boolean
language sql stable set search_path='' as $$
 select coalesce((select not l.blocked and s.is_active and s.id=i.deliverer_id
  and l.linked_at<=o.created_at and t.resolved_at is null and i.status='取引中' and i.shipped_on is null
  and i.sold_on is null and i.seller_cancelled_at is null
  and i.sales_channel in ('メルカリ','ヤフオク') and o.trade_key=i.seller_trade_key
  and exists(select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key and sl.channel=i.sales_channel)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=s.id and c.item_id=i.id and c.notice_id='shipping:'||t.id::text)
 from app.delivery_line_outbox o join app.delivery_line_links l on l.id=o.link_id join app.staff s on s.id=l.staff_id
 join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id where o.id=p_id),false);
$$;
create function app.line_shipping_media(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('itemId',i.id,'serial',app.product_serial(i.sku,i.lot_seq),'sku',i.sku,
  'supplierUrl',i.marketplace_url,'photoPaths',jsonb_build_array(front.storage_path,model.storage_path),'codeOperationId',code.id,
  'withoutBarcode',case when code.id is null then 'size_unset' end)
 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id
 join app.delivery_line_preferences pref on pref.item_id=i.id
 join app.item_photos front on front.id=pref.overview_photo_id and coalesce(front.photo_kind,'product')='product'
 join app.item_photos model on model.id=pref.model_photo_id and coalesce(model.photo_kind,'product')='product'
 join app.seller_listings listing on listing.item_id=i.id and listing.active and listing.trade_key=o.trade_key
 left join lateral(select op.payload->>'size' size from app.seller_operations op
  where op.item_id=i.id and op.account_id=listing.account_id and op.channel=listing.channel and op.kind='listing'
   and op.status='succeeded' and op.result->>'external_id'=listing.external_id order by op.created_at desc limit 1) saved on true
 left join lateral(select op.id from app.seller_operations op join app.seller_listings sl on sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key
  where op.item_id=i.id and op.account_id=sl.account_id and op.channel=sl.channel and op.kind in ('shipping_code','register_package')
   and op.status='succeeded' and op.payload->>'trade_key'=o.trade_key and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null order by op.created_at desc limit 1) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id)
  and (code.id is not null or coalesce(app.line_fixed_shipping_size(i.id),nullif(pref.shipping->>'size',''),nullif(saved.size,''),app.line_learned_shipping_size(i.id)) is null);
$$;

create function app.line_shipping_context(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare i app.items;p app.delivery_line_preferences;q app.delivery_line_outbox;reason text;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then raise exception '担当商品のみ確認できます' using errcode='42501';end if;
 select * into p from app.delivery_line_preferences where item_id=i.id;
 select o.* into q from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id
 where t.item_id=i.id order by o.created_at desc limit 1;
 reason:=case when p.model_photo_id is null or p.overview_photo_id is null then '通知写真を指定してください'
  when q.id is null then '次の新しい発送依頼から自動通知します'
  when q.state='sent' then 'LINEへ送信済み'
  when q.state='cancelled' then 'この発送依頼は終了しました'
  when q.last_error is not null then q.last_error
  when app.line_shipping_media(q.id) is null then '配送設定・発送コードの確認待ちです'
  else 'LINE通知の準備中です' end;
 return jsonb_build_object('overviewPhotoId',p.overview_photo_id,'modelPhotoId',p.model_photo_id,'shipping',coalesce(p.shipping,'{}'),
  'state',q.state,'message',reason,'enabled',coalesce((select enabled from app.delivery_line_settings where singleton),false));
end $$;

-- One request after the patrol, and one for each actual operation completion.
-- No permanent minute poll. Completed/uncertain code operations are never issued twice.
create function app.extension_prepare_line_shipping(p_account_ids text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o record;i app.items;settings jsonb;operation uuid;n integer:=0;reason text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if cardinality(p_account_ids) not between 1 and 4 or exists(select 1 from unnest(p_account_ids) a where a not in ('mercari-1','mercari-2','auctions-1','auctions-2') or a is null) then raise exception 'アカウントを確認してください';end if;
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return jsonb_build_object('queued',0);end if;
 for o in select q.id,q.trade_key,t.item_id,l.account_id,l.trade_key current_trade from app.delivery_line_outbox q
 join app.delivery_shipping_tasks t on t.id=q.task_id join app.items item on item.id=t.item_id
 join app.seller_listings l on l.item_id=item.id and l.active and l.account_id=any(p_account_ids)
 where q.state='pending' and q.attempts=0
 and exists(select 1 from app.delivery_line_preferences pref where pref.item_id=item.id and pref.overview_photo_id is not null and pref.model_photo_id is not null)
 order by q.created_at limit 20 for update of q skip locked loop
  if o.trade_key is null then update app.delivery_line_outbox set trade_key=o.current_trade where id=o.id;end if;
  if not app.line_shipping_eligible(o.id) then update app.delivery_line_outbox set state='cancelled' where id=o.id;continue;end if;
  if app.line_shipping_media(o.id) is not null then continue;end if;
  select * into i from app.items where id=o.item_id;
  reason:=null;
  if not exists(select 1 from app.delivery_line_preferences where item_id=i.id and overview_photo_id is not null and model_photo_id is not null) then reason:='通知写真を指定してください';end if;
  settings:=coalesce(app.seller_operation_context(i.id)->'shipping_defaults','{}')||coalesce((select shipping from app.delivery_line_preferences where item_id=i.id),'{}');
  if nullif(settings->>'size','') is null and app.line_learned_shipping_size(i.id) is not null then settings:=settings||jsonb_build_object('size',app.line_learned_shipping_size(i.id));end if;
  if app.line_fixed_shipping_size(i.id) is not null then settings:=settings||jsonb_build_object('size',app.line_fixed_shipping_size(i.id));end if;
  if coalesce(settings->>'size','') not in ('100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケット')
   or coalesce(settings->>'shippingMethod','') not in ('らくらくメルカリ便','ゆうゆうメルカリ便','おてがる配送（ヤマト運輸）','おてがる配送（日本郵便）')
   or (settings->>'shippingMethod' in ('らくらくメルカリ便','おてがる配送（ヤマト運輸）') and coalesce(settings->>'dropoff','') not in ('セブンイレブン','ヤマト営業所'))
   or (settings->>'shippingMethod' in ('ゆうゆうメルカリ便','おてがる配送（日本郵便）') and coalesce(settings->>'dropoff','') not in ('ローソン','郵便局')) then reason:=coalesce(reason,'配送サイズ・発送場所を保存してください');end if;
  if reason is not null then update app.delivery_line_outbox set last_error=reason where id=o.id;continue;end if;
  if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) then continue;end if;
  if exists(select 1 from app.seller_operations where item_id=i.id and kind='shipping_code' and payload->>'trade_key'=o.current_trade and payload ? 'automatic_line') then
   update app.delivery_line_outbox set last_error='発送コードを自動取得できませんでした。発送画面で確認してください' where id=o.id;continue;
  end if;
  begin
   operation:=app.queue_seller_operation(i.id,'shipping_code',settings||jsonb_build_object('trade_key',o.current_trade,'expected_revision',i.updated_at,'automatic_line',o.id),gen_random_uuid());
   n:=n+1;update app.delivery_line_outbox set last_error=null where id=o.id;
  exception when others then update app.delivery_line_outbox set last_error='発送コードの取得待ちです。発送画面で確認してください' where id=o.id;
  end;
 end loop;
 perform app.kick_delivery_line();
 return jsonb_build_object('queued',n);
end $$;

create function app.arm_delivery_line_retry() returns void
language plpgsql security definer set search_path='' as $$
declare retry_at timestamptz;
begin
 select min(next_attempt_at) into retry_at from app.delivery_line_outbox
 where (state='pending' and attempts between 1 and 4 or state='sending' and attempts between 1 and 5);
 if retry_at is null then
  perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-retry';return;
 end if;
 retry_at:=greatest(date_trunc('minute',now())+interval '1 minute',date_trunc('minute',retry_at)+interval '1 minute');
 perform cron.schedule('delivery-line-retry',to_char(retry_at at time zone 'UTC','MI HH24 DD MM')||' *','select app.retry_delivery_line();');
end $$;
create or replace function app.claim_delivery_line() returns table(id uuid,lease uuid,recipient text,payload jsonb,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return;end if;
 update app.delivery_line_outbox o set state='failed',last_error='LINE通知を完了できませんでした。管理者へ確認してください'
 where o.state in ('pending','sending') and o.next_attempt_at<=now() and (o.attempts>=5 or o.first_attempt_at<now()-interval '23 hours');
 return query with ready as (
 select o.id from app.delivery_line_outbox o where o.state in ('pending','sending') and o.next_attempt_at<=now() and o.attempts<5
  and coalesce(o.first_attempt_at,now())>now()-interval '23 hours' and app.line_shipping_media(o.id) is not null order by o.next_attempt_at limit 2 for update skip locked
 ),claimed as (
 update app.delivery_line_outbox o set state='sending',attempts=o.attempts+1,first_attempt_at=coalesce(o.first_attempt_at,now()),
 next_attempt_at=now()+interval '5 minutes',lease=gen_random_uuid() from ready r where o.id=r.id returning o.*
 ) select o.id,o.lease,l.line_user_id,coalesce(o.message_payload,jsonb_build_object('media',app.line_shipping_media(o.id))),app.line_shipping_eligible(o.id)
 from claimed o join app.delivery_line_links l on l.id=o.link_id;
 perform app.arm_delivery_line_retry();
end $$;
create function app.prepare_delivery_line_message(p_id uuid,p_lease uuid,p_messages jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not app.line_shipping_eligible(p_id) or jsonb_typeof(p_messages) is distinct from 'object' or octet_length(p_messages::text)>20000 then return false;end if;
 update app.delivery_line_outbox set message_payload=coalesce(message_payload,p_messages) where id=p_id and lease=p_lease and state='sending';
 return found;
end $$;

create or replace function app.kick_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text;project_url text;request_id bigint;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) or not exists(
  select 1 from app.delivery_line_outbox o where state in ('pending','sending') and next_attempt_at<=now()
   and attempts<5 and app.line_shipping_media(o.id) is not null
 ) then return null;end if;
 select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
 select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
 if dispatch_token is null or project_url is null then return null;end if;
 select net.http_post(url:=project_url||'/functions/v1/delivery-line',headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
 body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=50000) into request_id;return request_id;
end $$;
create function app.retry_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
begin
 perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-retry';
 update app.delivery_line_outbox set state='failed',last_error='LINE通知を完了できませんでした。管理者へ確認してください'
 where state in ('pending','sending') and next_attempt_at<=now() and (attempts>=5 or first_attempt_at<now()-interval '23 hours');
 update app.delivery_line_outbox o set state='cancelled' where state in ('pending','sending') and attempts>0
  and (not app.line_shipping_eligible(o.id) or app.line_shipping_media(o.id) is null);
 perform app.arm_delivery_line_retry();
 return app.kick_delivery_line();
end $$;
create or replace function app.finish_delivery_line(p_id uuid,p_lease uuid,p_state text,p_status integer) returns void
language plpgsql security definer set search_path='' as $$
begin
 update app.delivery_line_outbox set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
 last_status=p_status,sent_at=case when p_state='sent' then now() else sent_at end,next_attempt_at=now()+interval '5 minutes',
 last_error=case when p_state='failed' or p_state='pending' and attempts>=5 then 'LINEへの通知に失敗しました。管理者へ確認してください' else last_error end
 where id=p_id and lease=p_lease and state='sending' and p_state in ('pending','sent','cancelled','failed');
 if found then perform app.arm_delivery_line_retry();end if;
end $$;
create function app.capture_line_code_completion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind in ('shipping_code','register_package') and new.status='succeeded' and old.status is distinct from new.status then perform app.kick_delivery_line();end if;
 return new;
end $$;
create trigger seller_operation_line_code after update of status on app.seller_operations for each row execute function app.capture_line_code_completion();
do $$begin perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-shipping';end $$;

revoke all on function app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb),app.line_shipping_context(uuid) from public,anon;
grant execute on function app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb),app.line_shipping_context(uuid) to authenticated;
revoke all on function app.extension_prepare_line_shipping(text[]) from public,anon;
grant execute on function app.extension_prepare_line_shipping(text[]) to authenticated;
revoke all on function app.line_shipping_eligible(uuid),app.line_shipping_media(uuid),app.prepare_delivery_line_message(uuid,uuid,jsonb),app.retry_delivery_line(),app.arm_delivery_line_retry(),app.capture_line_code_completion() from public,anon,authenticated;
grant execute on function app.line_shipping_eligible(uuid),app.line_shipping_media(uuid),app.prepare_delivery_line_message(uuid,uuid,jsonb),app.retry_delivery_line() to service_role;
notify pgrst,'reload schema';


-- ▼▼▼ 20261024074147_reduce_idle_polling.sql ▼▼▼

-- Push wakes on new events. A temporary, self-removing alarm covers transport
-- failure and claim leases; an empty queue has no recurring DB or HTTP work.
create function app.arm_delivery_push_retry() returns void
language plpgsql security definer set search_path='' as $$
declare due_at timestamptz; newest timestamptz; alarm_at timestamptz; spec text; age interval;
begin
  perform pg_advisory_xact_lock(1735907191);
  select min(next_attempt_at),max(created_at) into due_at,newest from (
    select d.next_attempt_at,e.created_at from app.delivery_push_deliveries d
      join app.delivery_push_events e on e.id=d.event_id
      where d.state in ('pending','sending') and (d.attempts<5 or d.state='sending')
        and e.created_at>now()-interval '24 hours'
    union all
    select d.next_attempt_at,e.created_at from app.admin_push_deliveries d
      join app.admin_push_events e on e.id=d.event_id
      where d.state in ('pending','sending') and (d.attempts<5 or d.state='sending')
        and e.created_at>now()-interval '24 hours'
    union all
    select now(),e.created_at from app.delivery_push_events e
      join app.delivery_push_subscriptions s on s.staff_id=e.staff_id
        and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
      where e.created_at>now()-interval '24 hours' and not exists(
        select 1 from app.delivery_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
    union all
    select now(),e.created_at from app.admin_push_events e
      join app.delivery_push_subscriptions s on s.staff_id=e.staff_id
        and s.app_kind='admin' and s.enabled and s.created_at<=e.created_at
      where e.created_at>now()-interval '24 hours' and not exists(
        select 1 from app.admin_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
  ) work;
  if due_at is null then
    perform cron.unschedule(jobid) from cron.job where jobname='delivery-push-retry';
    return;
  end if;
  age:=now()-newest;
  -- Failed HTTP requests before a claim back off, rather than poll forever.
  alarm_at:=case when due_at>now() then due_at else now()+case
    when age<interval '5 minutes' then interval '5 minutes'
    when age<interval '15 minutes' then interval '10 minutes'
    when age<interval '35 minutes' then interval '20 minutes'
    when age<interval '75 minutes' then interval '40 minutes'
    else interval '1 hour' end end;
  alarm_at:=date_trunc('minute',alarm_at)+interval '1 minute';
  spec:=to_char(alarm_at at time zone 'UTC','MI HH24 DD MM')||' *';
  if not exists(select 1 from cron.job j where j.jobname='delivery-push-retry' and to_jsonb(j)->>'schedule'=spec) then
    perform cron.schedule('delivery-push-retry',spec,'select app.retry_delivery_push();');
  end if;
end;
$$;

create function app.retry_delivery_push() returns bigint
language plpgsql security definer set search_path='' as $$
declare request_id bigint;
begin
  perform pg_advisory_xact_lock(1735907191);
  perform cron.unschedule(jobid) from cron.job where jobname='delivery-push-retry';
  -- Preserve the existing 24h expiry and five-attempt limit.
  update app.delivery_push_deliveries d set state='cancelled' from app.delivery_push_events e
    where d.event_id=e.id and d.state in ('pending','sending') and e.created_at<=now()-interval '24 hours';
  update app.admin_push_deliveries d set state='cancelled' from app.admin_push_events e
    where d.event_id=e.id and d.state in ('pending','sending') and e.created_at<=now()-interval '24 hours';
  begin
    request_id:=app.kick_delivery_push();
  exception when others then
    raise warning 'Push dispatch unavailable; pending events retained for retry';
  end;
  perform app.arm_delivery_push_retry();
  return request_id;
end;
$$;

-- Keep the current eligibility guards, Vault authentication and HTTP dispatch.
-- Only deduplicate dispatch within a transaction and arm its failure watchdog.
do $$declare source text;begin
  source:=pg_get_functiondef('app.kick_delivery_push()'::regprocedure);
  if position('begin' in source)=0 or position('  return request_id;' in source)=0 then
    raise exception 'Unexpected push dispatcher definition';
  end if;
  source:=replace(source,E'begin\n',E'begin\n  if current_setting(''app.web_push_kicked'',true)=''1'' then return null; end if;\n');
  source:=replace(source,'  return request_id;',E'  perform set_config(''app.web_push_kicked'',''1'',true);\n  perform app.arm_delivery_push_retry();\n  return request_id;');
  execute source;
  source:=pg_get_functiondef('app.initialize_delivery_push(text,text,text)'::regprocedure);
  if position('delivery-task-web-push' in source)=0 then raise exception 'Unexpected push initializer definition';end if;
  source:=replace(source,'perform cron.schedule(''delivery-task-web-push'',''* * * * *'',''select app.kick_delivery_push();'');','perform app.kick_delivery_push();');
  execute source;
end $$;

create function app.wake_delivery_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  begin
    perform app.kick_delivery_push();
  exception when others then
    -- Dispatch transport must not roll back the user's inventory/task update.
    raise warning 'Push dispatch unavailable; pending events retained for retry';
  end;
  perform app.arm_delivery_push_retry();
  return null;
end;
$$;
create function app.rearm_delivery_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform app.arm_delivery_push_retry();
  return null;
end;
$$;
create trigger wake_delivery_push after insert on app.delivery_push_events
  for each statement execute function app.wake_delivery_push();
create trigger wake_admin_push after insert on app.admin_push_events
  for each statement execute function app.wake_delivery_push();
create trigger wake_push_subscription after insert or update of enabled on app.delivery_push_subscriptions
  for each statement execute function app.wake_delivery_push();
create trigger rearm_delivery_push after insert or update of state,next_attempt_at on app.delivery_push_deliveries
  for each statement execute function app.rearm_delivery_push();
create trigger rearm_admin_push after insert or update of state,next_attempt_at on app.admin_push_deliveries
  for each statement execute function app.rearm_delivery_push();

revoke all on function app.arm_delivery_push_retry(),app.retry_delivery_push(),app.wake_delivery_push(),app.rearm_delivery_push() from public,anon,authenticated;
grant execute on function app.arm_delivery_push_retry(),app.retry_delivery_push() to service_role;
select cron.unschedule(jobid) from cron.job where jobname='delivery-task-web-push';
select app.arm_delivery_push_retry();

-- Expired messages are already hidden by the read RPC. Physical cleanup is
-- maintenance, not notification delivery: hourly is sufficient.
select cron.schedule('marketplace-message-retention','17 * * * *','select app.purge_expired_marketplace_messages()');


-- ▼▼▼ 20261024100629_line_photo_listing_order.sql ▼▼▼

-- The publication stores the seller's chosen order, which may differ from
-- upload timestamps. Expose only authorized photo IDs, never old signed URLs.
create function app.line_listing_photo_order(p_item_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(ordered.id order by ordered.position),'[]'::jsonb) from (
  select p.id,min(photo.position) as position
  from app.seller_listings listing
  cross join lateral (
   select op.payload->'photos' as photos from app.seller_operations op
   where op.item_id=listing.item_id and op.kind='listing' and op.status='succeeded'
    and op.account_id=listing.account_id and op.channel=listing.channel
    and op.result->>'external_id'=listing.external_id
   order by op.created_at desc,op.id desc limit 1
  ) published
  cross join lateral jsonb_array_elements_text(case when jsonb_typeof(published.photos)='array' then published.photos else '[]'::jsonb end)
   with ordinality as photo(url,position)
  join app.items target on target.id=listing.item_id
  join app.items source on source.lot_seq=target.lot_seq and app.product_serial(source.sku,source.lot_seq)=app.product_serial(target.sku,target.lot_seq)
  join app.item_photos p on p.item_id=source.id and coalesce(p.photo_kind,'product')='product'
   and p.storage_path=substring(split_part(photo.url,'?',1) from '^https://[^/]+/storage/v1/object/(?:sign|public)/item-photos/(.+)$')
  where listing.item_id=p_item_id and listing.active
  group by p.id
 ) ordered;
$$;
revoke all on function app.line_listing_photo_order(uuid) from public,anon,authenticated;
grant execute on function app.line_listing_photo_order(uuid) to service_role;
do $$declare source text;patched text;begin
 source:=pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 patched:=replace(source,$old$'overviewPhotoId',p.overview_photo_id,$old$,$new$'photoOrder',app.line_listing_photo_order(i.id),'overviewPhotoId',p.overview_photo_id,$new$);
 if patched=source then raise exception 'LINE shipping context changed';end if;
 execute patched;
end $$;


-- ▼▼▼ 20261024225104_daily_marketplace_price_reduction.sql ▼▼▼

create table app.marketplace_price_changes (
 channel text not null check(channel='メルカリ'), external_id text not null check(external_id ~ '^m[0-9]+$'),
 day date not null, account_id text not null check(account_id in ('mercari-1','mercari-2')),
 item_id uuid not null references app.items(id), token uuid not null default gen_random_uuid(),
 before_price bigint not null check(before_price between 400 and 9999999), after_price bigint not null check(after_price=before_price-100 and after_price>=300),
 title text not null, state text not null check(state in ('reserved','submitting','succeeded','failed','unknown')),
 note text not null default '', created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 primary key(channel,external_id,day)
);
create unique index marketplace_price_unresolved on app.marketplace_price_changes(channel,external_id) where state in ('reserved','submitting','unknown');
alter table app.marketplace_price_changes enable row level security;
revoke all on app.marketplace_price_changes from public,anon;
grant select,insert,update on app.marketplace_price_changes to authenticated;
create policy marketplace_price_admin on app.marketplace_price_changes for all to authenticated using(app.is_admin()) with check(app.is_admin());

create function app.marketplace_price_candidates(p_account_id text) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者認証が必要です' using errcode='42501';end if;
 if p_account_id not in ('mercari-1','mercari-2') or p_account_id is null then raise exception '対象アカウントが不正です';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('external_id',l.external_id,'item_id',i.id,'sku',i.sku,'url',l.url) order by i.sku)
 from app.seller_listings l join app.items i on i.id=l.item_id
 where l.active and l.account_id=p_account_id and l.channel='メルカリ' and i.sales_channel=l.channel and i.status='出品中' and l.observed_status='出品中'
 and i.sold_on is null and i.seller_cancelled_at is null and not coalesce(i.malfunction_reported,false)
 and l.external_id ~ '^m[0-9]+$' and l.url='https://jp.mercari.com/item/'||l.external_id and split_part(i.sku,'-',1) ~ '^[0-9]+[a-zA-Z]*$'
 and not exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain'))
 and not exists(select 1 from app.marketplace_price_changes r where r.channel='メルカリ' and r.external_id=l.external_id and (r.day=(now() at time zone 'Asia/Tokyo')::date or r.state in ('reserved','submitting','unknown')))), '[]'::jsonb);
end $$;

create function app.marketplace_price_record(p_account_id text,p_external_id text,p_action text,p_day date,p_before bigint default null,p_after bigint default null,p_title text default null,p_token uuid default null,p_note text default '') returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare r app.marketplace_price_changes;i app.items;l app.seller_listings;matches text[];stamp timestamp:=clock_timestamp() at time zone 'Asia/Tokyo';
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者認証が必要です' using errcode='42501';end if;
 if p_account_id not in ('mercari-1','mercari-2') or p_account_id is null or p_external_id !~ '^m[0-9]+$' or p_external_id is null or p_day is null then raise exception '対象を確認してください';end if;
 perform pg_advisory_xact_lock(hashtextextended('marketplace-price:'||p_external_id,0));
 select * into r from app.marketplace_price_changes where channel='メルカリ' and external_id=p_external_id and day=p_day for update;
 if p_action='reserve' then
  if p_day<>stamp::date or extract(hour from stamp)<12 then raise exception '正午12時以降の当日処理だけ実行できます';end if;
  if r.external_id is not null or exists(select 1 from app.marketplace_price_changes where channel='メルカリ' and external_id=p_external_id and state in ('reserved','submitting','unknown')) then return jsonb_build_object('claimed',false);end if;
  select * into l from app.seller_listings where channel='メルカリ' and account_id=p_account_id and external_id=p_external_id and active;
  if l.item_id is null then raise exception '出品と在庫が一致しません';end if;
  select * into i from app.items where id=l.item_id for update;
  if i.status<>'出品中' or l.observed_status<>'出品中' or i.sold_on is not null or i.sales_channel<>l.channel or i.seller_cancelled_at is not null or coalesce(i.malfunction_reported,false) or exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain')) then raise exception '商品状態が変更されています';end if;
  select array_agg(lower(m[1])) into matches from regexp_matches(coalesce(p_title,''),'[【\[]([0-9]+[a-zA-Z]*)[】\]]','g') m;
  if coalesce(cardinality(matches),0)<>1 or matches[1]<>lower(split_part(i.sku,'-',1)) or length(p_title)>256 or p_before not between 400 and 9999999 or p_before is null or p_after is distinct from p_before-100 then raise exception '通番号・価格が一致しません';end if;
  insert into app.marketplace_price_changes(channel,external_id,day,account_id,item_id,before_price,after_price,title,state) values('メルカリ',p_external_id,p_day,p_account_id,i.id,p_before,p_after,p_title,'reserved') returning * into r;
  return jsonb_build_object('claimed',true,'token',r.token);
 end if;
 if r.external_id is null or r.account_id<>p_account_id or r.token is distinct from p_token then raise exception '予約が一致しません';end if;
 if p_action='begin' then
  if r.state<>'reserved' or p_day<>stamp::date or extract(hour from stamp)<12 or clock_timestamp()-r.created_at>interval '10 minutes' then raise exception '予約期限・状態を確認してください';end if;
  select * into i from app.items where id=r.item_id for update;
  if i.status<>'出品中' or i.sold_on is not null or i.seller_cancelled_at is not null or coalesce(i.malfunction_reported,false) or exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain')) or not exists(select 1 from app.seller_listings l where l.item_id=i.id and l.external_id=p_external_id and l.account_id=p_account_id and l.channel=i.sales_channel and l.active and l.observed_status='出品中') then raise exception '送信前の商品状態が変わりました';end if;
  update app.marketplace_price_changes set state='submitting',updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='complete' and r.state='submitting' then
  update app.marketplace_price_changes set state='succeeded',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='unknown' and r.state='submitting' then
  update app.marketplace_price_changes set state='unknown',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='failed' and r.state='reserved' then
  update app.marketplace_price_changes set state='failed',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 else raise exception '送信状態を自動解除・再実行できません';end if;
 return jsonb_build_object('recorded',true);
end $$;
revoke all on function app.marketplace_price_candidates(text) from public,anon;
revoke all on function app.marketplace_price_record(text,text,text,date,bigint,bigint,text,uuid,text) from public,anon;
grant execute on function app.marketplace_price_candidates(text) to authenticated;
grant execute on function app.marketplace_price_record(text,text,text,date,bigint,bigint,text,uuid,text) to authenticated;


-- ▼▼▼ 20261024225154_price_change_begin_guard.sql ▼▼▼

create or replace function app.marketplace_price_record(p_account_id text,p_external_id text,p_action text,p_day date,p_before bigint default null,p_after bigint default null,p_title text default null,p_token uuid default null,p_note text default '') returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare r app.marketplace_price_changes;i app.items;l app.seller_listings;matches text[];stamp timestamp:=clock_timestamp() at time zone 'Asia/Tokyo';
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者認証が必要です' using errcode='42501';end if;
 if p_account_id not in ('mercari-1','mercari-2') or p_account_id is null or p_external_id !~ '^m[0-9]+$' or p_external_id is null or p_day is null then raise exception '対象を確認してください';end if;
 perform pg_advisory_xact_lock(hashtextextended('marketplace-price:'||p_external_id,0));
 select * into r from app.marketplace_price_changes where channel='メルカリ' and external_id=p_external_id and day=p_day for update;
 if p_action='reserve' then
  if p_day<>stamp::date or extract(hour from stamp)<12 then raise exception '正午12時以降の当日処理だけ実行できます';end if;
  if r.external_id is not null or exists(select 1 from app.marketplace_price_changes where channel='メルカリ' and external_id=p_external_id and state in ('reserved','submitting','unknown')) then return jsonb_build_object('claimed',false);end if;
  select * into l from app.seller_listings where channel='メルカリ' and account_id=p_account_id and external_id=p_external_id and active;
  if l.item_id is null then raise exception '出品と在庫が一致しません';end if;
  select * into i from app.items where id=l.item_id for update;
  if i.status<>'出品中' or l.observed_status<>'出品中' or i.sold_on is not null or i.sales_channel<>l.channel or i.seller_cancelled_at is not null or coalesce(i.malfunction_reported,false) or exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain')) then raise exception '商品状態が変更されています';end if;
  select array_agg(lower(m[1])) into matches from regexp_matches(coalesce(p_title,''),'[【\[]([0-9]+[a-zA-Z]*)[】\]]','g') m;
  if coalesce(cardinality(matches),0)<>1 or matches[1]<>lower(split_part(i.sku,'-',1)) or length(p_title)>256 or p_before not between 400 and 9999999 or p_before is null or p_after is distinct from p_before-100 then raise exception '通番号・価格が一致しません';end if;
  insert into app.marketplace_price_changes(channel,external_id,day,account_id,item_id,before_price,after_price,title,state) values('メルカリ',p_external_id,p_day,p_account_id,i.id,p_before,p_after,p_title,'reserved') returning * into r;
  return jsonb_build_object('claimed',true,'token',r.token);
 end if;
 if r.external_id is null or r.account_id<>p_account_id or r.token is distinct from p_token then raise exception '予約が一致しません';end if;
 if p_action='begin' then
  if r.state<>'reserved' or p_day<>stamp::date or extract(hour from stamp)<12 or clock_timestamp()-r.created_at>interval '10 minutes' then raise exception '予約期限・状態を確認してください';end if;
  select * into i from app.items where id=r.item_id for update;
  if i.status<>'出品中' or i.sold_on is not null or i.seller_cancelled_at is not null or coalesce(i.malfunction_reported,false) or exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain')) or not exists(select 1 from app.seller_listings listing where listing.item_id=i.id and listing.external_id=p_external_id and listing.account_id=p_account_id and listing.channel=i.sales_channel and listing.active and listing.observed_status='出品中') then raise exception '送信前の商品状態が変わりました';end if;
  update app.marketplace_price_changes set state='submitting',updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='complete' and r.state='submitting' then
  update app.marketplace_price_changes set state='succeeded',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='unknown' and r.state='submitting' then
  update app.marketplace_price_changes set state='unknown',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='failed' and r.state='reserved' then
  update app.marketplace_price_changes set state='failed',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 else raise exception '送信状態を自動解除・再実行できません';end if;
 return jsonb_build_object('recorded',true);
end $$;


-- ▼▼▼ 20261024230242_price_ledger_item_index.sql ▼▼▼

create index marketplace_price_changes_item_idx on app.marketplace_price_changes(item_id);


-- ▼▼▼ 20261025141215_damage_report_yahoo_instructions.sql ▼▼▼

-- The eight vendor instructions always separate the remote.
-- Move a separately registered accessory, otherwise register the bundled remote.
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare previous_channel app.sales_channel; existing_spare boolean;
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and (i.status='動作不良' or (i.status='Amazon補填申請中' and new.task_kind like '%ヤフオク%')) and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 select sales_channel into previous_channel from app.items where id=new.item_id for update;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  if new.task_kind in ('Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
                       'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク')
   and exists(select 1 from app.items body where body.id=new.item_id and not body.is_accessory) then
   select exists(select 1 from app.spare_accessories s join app.items body on body.id=new.item_id
    where lower(btrim(s.usage_note))=lower(app.product_serial(body.sku,body.lot_seq)) and s.title ilike '%リモコン%') into existing_spare;
   -- Transfer before the body update can synchronize the accessory SKU.
   perform app.prepare_yahoo_auction_item(new.item_id);
   -- Preserve the explicit fault report on a newly registered, bundled (zero extra cost) remote.
   if not existing_spare and exists(select 1 from app.items where id=new.item_id
    and malfunction_comment ~ 'リモコン[^。\n]{0,30}(作動しない|動かない|不動|反応しない)') then
    update app.spare_accessories s set title='リモコン（作動しないとの報告あり）'
    from app.items body where body.id=new.item_id and lower(btrim(s.usage_note))=lower(app.product_serial(body.sku,body.lot_seq))
     and s.source_sku is null and s.cost_amount=0 and s.used_for_item_id is null;
   end if;
  end if;
  update app.items set
   workflow_previous_sales_channel=previous_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;


-- ▼▼▼ 20261025144315_normalize_return_spare_parent_serial.sql ▼▼▼

-- Preserve explicit parent links when registering an Amazon-return spare with a new body.
create or replace function app.enforce_amazon_return_main_item()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
  parent_id uuid;
  parent_count integer := 0;
  numeric_serial text;
  separator_and_tail text;
  parent_serial text;
  existing_depth integer;
  requested_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then return new; end if;

  if tg_op <> 'INSERT' then
    if new.amazon_returned_on is not null then new.is_accessory := false; end if;
    return new;
  end if;

  if new.is_accessory and new.work_stream::text = '付属品'
     and auth.uid() is not null and app.current_role() in ('admin','purchaser') then
    -- Resolve by the strongest available identity first. Numeric lot alone is used
    -- only when it identifies exactly one main item.
    if new.parent_item_id is not null then
      select p.id into parent_id from app.items p
       where p.id = new.parent_item_id and not p.is_accessory and p.lot_seq = new.lot_seq;
      if parent_id is null then
        raise exception '指定した本体が見つかりません。通番号を確認してください' using errcode='22023';
      end if;
      -- An explicit, validated parent is already exactly one match.
      parent_count := 1;
    end if;
    if parent_id is null and new.product_id is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.product_id = new.product_id;
    end if;
    if parent_id is null and nullif(new.marketplace_item_id,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_item_id = new.marketplace_item_id;
    end if;
    if parent_id is null and nullif(new.marketplace_url,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_url = new.marketplace_url;
    end if;
    if parent_id is null and nullif(new.asin,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.asin = new.asin and p.title = new.title;
    end if;
    if parent_id is null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p
       where not p.is_accessory and p.lot_seq = new.lot_seq;
    end if;
    if parent_count <> 1 or parent_id is null then
      raise exception '同じ通番号の本体を一意に特定できません。商品ID・ASIN・仕入先URLを確認してください' using errcode='22023';
    end if;
    select * into parent from app.items p where p.id = parent_id for update;
    new.parent_item_id := parent.id;
    new.marketplace_item_id := coalesce(new.marketplace_item_id, parent.marketplace_item_id);
    new.marketplace_url := coalesce(new.marketplace_url, parent.marketplace_url);
    new.product_id := coalesce(new.product_id, parent.product_id);
    new.asin := coalesce(new.asin, parent.asin);
    parent_serial := lower(app.product_serial(parent.sku, parent.lot_seq));
  else
    new.is_accessory := false;
  end if;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if parent_serial is null then parent_serial := numeric_serial; end if;
  if separator_and_tail is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended('amazon-return:'||new.lot_seq::text||':'||coalesce(parent_serial,numeric_serial),179049));

  select coalesce(max(
      case when lower(app.product_serial(i.sku,i.lot_seq)) like parent_serial || '%'
           then length(app.product_serial(i.sku,i.lot_seq))-length(parent_serial) else 0 end
    ),0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and i.id <> coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid);

  requested_depth := length(coalesce((regexp_match(new.sku,'^[0-9]+([a-z]*)[-_]'))[1],''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  if new.is_accessory and parent_id is not null then
    new.sku := parent_serial || repeat('a', next_depth) || separator_and_tail;
  else
    new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  end if;
  return new;
end;
$$;


-- ▼▼▼ 20261025224411_spare_shipping_management_completion.sql ▼▼▼

-- Management acknowledgement is independent of the holder's physical shipment.
alter table app.spare_shipping_tasks add column management_completed_at timestamptz;
grant update(management_completed_at) on app.spare_shipping_tasks to authenticated;
create policy spare_shipping_management_complete on app.spare_shipping_tasks
for update to authenticated using(app.is_admin()) with check(app.is_admin());

create or replace function app.complete_spare_shipping(p_task_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者のみ完了できます' using errcode='42501';
  end if;
  update app.spare_shipping_tasks
  set management_completed_at=coalesce(management_completed_at,now()),
      completed_at=case when sent_at is not null then coalesce(completed_at,now()) else completed_at end
  where id=p_task_id;
  if not found then raise exception '発送タスクが見つかりません' using errcode='22023'; end if;
end $$;
revoke all on function app.complete_spare_shipping(uuid) from public,anon;
grant execute on function app.complete_spare_shipping(uuid) to authenticated;

create or replace view app.v_spare_shipping_tasks with (security_invoker=true) as
select t.id,t.spare_id,t.item_id,t.accessory_item_id,t.owner_staff_id,t.recipient_staff_id,
       t.title,t.manufacturer,t.marketplace,t.marketplace_item_id,t.usage_note,t.lot_seq,
       t.tracking_no,t.created_at,t.sent_at,t.completed_at,
       o.code owner_code,o.name owner_name,d.code recipient_code,d.name recipient_name,
       t.management_completed_at
from app.spare_shipping_tasks t join app.staff o on o.id=t.owner_staff_id
join app.staff d on d.id=t.recipient_staff_id
where t.delivery_required or t.sent_at is not null;


-- ▼▼▼ 20261025224709_purchase_draft_to_spare.sql ▼▼▼

alter table app.marketplace_purchase_drafts add column registered_spare_id uuid references app.spare_accessories(id) on delete set null;

create function app.register_purchase_draft_spare(p_draft_id uuid,p_input jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare d app.marketplace_purchase_drafts%rowtype; spare_id uuid; owner_id uuid; owner_label text; item_title text; price bigint; purchase_date date; maker text;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者のみ登録できます' using errcode='42501'; end if;
  select * into d from app.marketplace_purchase_drafts where id=p_draft_id for update;
  if not found then raise exception '仕入れリストの商品が見つかりません' using errcode='22023'; end if;
  if d.state='registered' and d.registered_spare_id is not null then return d.registered_spare_id; end if;
  if d.state<>'draft' or d.registered_item_id is not null then raise exception 'この商品は既に処理されています。一覧を更新してください' using errcode='22023'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception '登録情報を確認してください' using errcode='22023'; end if;
  owner_id:=nullif(p_input->>'owner_staff_id','')::uuid;
  select name into owner_label from app.staff where id=owner_id and is_active;
  if owner_label is null then raise exception '保管担当者を選択してください' using errcode='22023'; end if;
  item_title:=nullif(btrim(p_input->>'title'),'');
  if item_title is null or length(item_title)>500 then raise exception '品名を入力してください' using errcode='22023'; end if;
  if coalesce(p_input->>'cost_amount','') !~ '^[0-9]{1,10}$' then raise exception '仕入金額は0円以上の整数にしてください' using errcode='22023'; end if;
  price:=(p_input->>'cost_amount')::bigint;
  if coalesce(p_input->>'purchased_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception '購入日を入力してください' using errcode='22023'; end if;
  purchase_date:=(p_input->>'purchased_at')::date;
  maker:=nullif(btrim(p_input->>'manufacturer'),'');
  if length(maker)>200 then raise exception 'メーカーは200文字以内にしてください' using errcode='22023'; end if;
  if exists(select 1 from app.spare_accessories s where s.marketplace=d.marketplace and s.marketplace_item_id=d.marketplace_item_id)
    or exists(select 1 from app.items i where i.source_purchase_draft_id=d.id or (i.marketplace::text=d.marketplace and i.marketplace_item_id=d.marketplace_item_id))
    then raise exception 'この商品は既に在庫または予備に登録されています。登録先を確認してください' using errcode='22023'; end if;
  insert into app.spare_accessories(owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,cost_amount,marketplace,marketplace_item_id,usage_note)
  values(owner_id,owner_label,purchase_date,item_title,maker,d.model_no,d.asin,price,d.marketplace,d.marketplace_item_id,null) returning id into spare_id;
  update app.marketplace_purchase_drafts set state='registered',registered_spare_id=spare_id where id=d.id;
  return spare_id;
end $$;
revoke all on function app.register_purchase_draft_spare(uuid,jsonb) from public,anon;
grant execute on function app.register_purchase_draft_spare(uuid,jsonb) to authenticated;


-- ▼▼▼ 20261025231237_purchase_form_spare_metadata.sql ▼▼▼

create or replace function app.register_purchase_draft_spare(p_draft_id uuid,p_input jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare d app.marketplace_purchase_drafts%rowtype; spare_id uuid; owner_id uuid; owner_label text; item_title text; price bigint; purchase_date date; maker text;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者のみ登録できます' using errcode='42501'; end if;
  select * into d from app.marketplace_purchase_drafts where id=p_draft_id for update;
  if not found then raise exception '仕入れリストの商品が見つかりません' using errcode='22023'; end if;
  if d.state='registered' and d.registered_spare_id is not null then return d.registered_spare_id; end if;
  if d.state<>'draft' or d.registered_item_id is not null then raise exception 'この商品は既に処理されています。一覧を更新してください' using errcode='22023'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception '登録情報を確認してください' using errcode='22023'; end if;
  owner_id:=nullif(p_input->>'owner_staff_id','')::uuid;
  select name into owner_label from app.staff where id=owner_id and is_active;
  if owner_label is null then raise exception '保管担当者を選択してください' using errcode='22023'; end if;
  item_title:=nullif(btrim(p_input->>'title'),'');
  if item_title is null or length(item_title)>500 then raise exception '品名を入力してください' using errcode='22023'; end if;
  if coalesce(p_input->>'cost_amount','') !~ '^[0-9]{1,10}$' then raise exception '仕入金額は0円以上の整数にしてください' using errcode='22023'; end if;
  price:=(p_input->>'cost_amount')::bigint;
  if coalesce(p_input->>'purchased_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception '購入日を入力してください' using errcode='22023'; end if;
  purchase_date:=(p_input->>'purchased_at')::date;
  maker:=nullif(btrim(p_input->>'manufacturer'),'');
  if length(maker)>200 then raise exception 'メーカーは200文字以内にしてください' using errcode='22023'; end if;
  if exists(select 1 from app.spare_accessories s where s.marketplace=d.marketplace and s.marketplace_item_id=d.marketplace_item_id)
    or exists(select 1 from app.items i where i.source_purchase_draft_id=d.id or (i.marketplace::text=d.marketplace and i.marketplace_item_id=d.marketplace_item_id))
    then raise exception 'この商品は既に在庫または予備に登録されています。登録先を確認してください' using errcode='22023'; end if;
  insert into app.spare_accessories(owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note)
  values(owner_id,owner_label,purchase_date,item_title,maker,case when p_input ? 'model_no' then nullif(btrim(p_input->>'model_no'),'') else d.model_no end,case when p_input ? 'asin' then nullif(upper(btrim(p_input->>'asin')),'') else d.asin end,price,d.marketplace,d.marketplace_item_id,nullif(btrim(p_input->>'tracking_no'),''),null) returning id into spare_id;
  update app.marketplace_purchase_drafts set state='registered',registered_spare_id=spare_id where id=d.id;
  return spare_id;
end $$;
revoke all on function app.register_purchase_draft_spare(uuid,jsonb) from public,anon;
grant execute on function app.register_purchase_draft_spare(uuid,jsonb) to authenticated;


-- ▼▼▼ 20261026235234_inherit_return_sku_cost.sql ▼▼▼

-- Return SKU tails identify the original purchase; the return's accounting cost stays unchanged.
create function app.return_sku_original_cost(p_sku text,p_lot integer) returns text
language plpgsql stable security definer set search_path='' as $$
declare matches integer; original_cost bigint;
begin
 if p_sku !~ '^[0-9]+[ab]+-[A-Z]{2,4}-[0-9]{8}-[0-9]+$' then return p_sku;end if;
 select count(*),min(i.cost_amount) into matches,original_cost from app.items i
 where not i.is_accessory and split_part(i.sku,'-',1)=p_lot::text;
 if matches<>1 then return p_sku;end if;
 return regexp_replace(p_sku,'-[0-9]+$','-'||(original_cost/10)::text);
end$$;
revoke all on function app.return_sku_original_cost(text,integer) from public,anon,authenticated;
CREATE OR REPLACE FUNCTION app.redirect_accessory_shared_edits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  parent app.items%rowtype; previous_redirect text;
begin
  -- A verified tail-only correction must not redirect unrelated accessory state.
  if new.sku is distinct from old.sku
     and regexp_replace(new.sku,'-[0-9]+$','')=regexp_replace(old.sku,'-[0-9]+$','')
     and to_jsonb(new)-'sku'-'updated_at'=to_jsonb(old)-'sku'-'updated_at'
     and new.sku=app.return_sku_original_cost(old.sku,old.lot_seq)
  then return new;end if;
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory
     or app.is_standalone_accessory_serial(old.sku,old.lot_seq) then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  select p.* into parent from app.items p
  where not p.is_accessory and (
    p.id = coalesce(new.parent_item_id, old.parent_item_id)
    or (new.parent_item_id is null and old.parent_item_id is null
        and p.lot_seq = old.lot_seq
        and app.product_serial(p.sku,p.lot_seq) = app.product_serial(old.sku,old.lot_seq))
  )
  order by (p.id = coalesce(new.parent_item_id, old.parent_item_id)) desc
  limit 1
  for update;

  if parent.id is null then
    raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください' using errcode='22023';
  end if;

  previous_redirect:=current_setting('app.redirecting_accessory_id',true);
  perform set_config('app.redirecting_accessory_id',old.id::text,true);
  update app.items set
    status = new.status,
    packed_on = new.packed_on,
    shipped_on = new.shipped_on,
    returned_on = new.returned_on,
    sales_channel = new.sales_channel,
    condition = new.condition,
    sold_on = new.sold_on,
    sold_price = new.sold_price,
    payout_amount = new.payout_amount,
    lot_seq = new.lot_seq,
    deliverer_id = new.deliverer_id,
    sku = parent.sku
  where id = parent.id;

  perform set_config('app.redirecting_accessory_id',coalesce(previous_redirect,''),true);
  select * into parent from app.items where id = parent.id;
  new.parent_item_id := parent.id;
  new.status := parent.status;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.returned_on := parent.returned_on;
  new.sales_channel := parent.sales_channel;
  new.condition := parent.condition;
  new.sold_on := parent.sold_on;
  new.sold_price := parent.sold_price;
  new.payout_amount := parent.payout_amount;
  new.lot_seq := parent.lot_seq;
  new.deliverer_id := parent.deliverer_id;
  new.sku := app.accessory_sku_for_parent(parent.sku, old.sku);
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION app.sync_sku_from_item_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare purchaser_code text; deliverer_code text; middle_code text; date_part text; suffix text;
  purchase_date_only boolean := new.purchased_at is distinct from old.purchased_at
    and new.lot_seq is not distinct from old.lot_seq
    and new.purchaser_id is not distinct from old.purchaser_id
    and new.deliverer_id is not distinct from old.deliverer_id
    and new.cost_amount is not distinct from old.cost_amount
    and new.sku is not distinct from old.sku;
begin
  if new.lot_seq is distinct from old.lot_seq
      or new.purchaser_id is distinct from old.purchaser_id
      or new.deliverer_id is distinct from old.deliverer_id
      or new.purchased_at is distinct from old.purchased_at
      or new.cost_amount is distinct from old.cost_amount then
    select code into purchaser_code from app.staff where id=new.purchaser_id;
    select code into deliverer_code from app.staff where id=new.deliverer_id;
    middle_code := coalesce(purchaser_code,'') || coalesce(deliverer_code,'');
    if middle_code='' then middle_code:=split_part(old.sku,'-',2); end if;
    if length(middle_code) not in (2,4) then raise exception '担当者コードを確認してください' using errcode='22023'; end if;
    date_part := case when new.purchased_at is null then split_part(old.sku,'-',3)
                      else to_char(new.purchased_at,'YYYYMMDD') end;
    suffix := coalesce(substring(new.sku from '^[0-9]+([a-z]+)-'),
                       substring(old.sku from '^[0-9]+([a-z]+)-'), '');
    new.sku := new.lot_seq::text || suffix || '-' || middle_code || '-' || date_part || '-' || (new.cost_amount / 10)::bigint;
  end if;
  new.sku:=app.return_sku_original_cost(new.sku,new.lot_seq);
  if exists (select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then
    if purchase_date_only and not exists(
      select 1 from app.item_sku_aliases a where a.sku=old.sku and a.item_id<>new.id
    ) then
      new.sku:=old.sku;
    else
      raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';
    end if;
  end if;
  return new;
end $function$
;
create function app.normalize_return_sku_insert() returns trigger
language plpgsql security definer set search_path='pg_catalog','app' as $$
begin new.sku:=app.return_sku_original_cost(new.sku,new.lot_seq);
 if exists(select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';end if;
 return new;end$$;
revoke all on function app.normalize_return_sku_insert() from public,anon,authenticated;
create trigger items_zzz_return_sku_original_cost before insert on app.items for each row execute function app.normalize_return_sku_insert();
drop trigger items_record_sku_alias on app.items;
create trigger items_record_sku_alias after update on app.items for each row when (old.sku is distinct from new.sku) execute function app.record_item_sku_alias();
CREATE OR REPLACE FUNCTION app.sync_accessory_sale_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  accessory app.items%rowtype;
begin
  if new.sku is distinct from old.sku
     and regexp_replace(new.sku,'-[0-9]+$','')=regexp_replace(old.sku,'-[0-9]+$','')
     and to_jsonb(new)-'sku'-'updated_at'=to_jsonb(old)-'sku'-'updated_at'
     and new.sku=app.return_sku_original_cost(old.sku,old.lot_seq)
  then return new;end if;
  if new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  for accessory in
    select a.* from app.items a
    where a.id::text is distinct from nullif(current_setting('app.redirecting_accessory_id',true),'')
      and a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and (
      a.parent_item_id = new.id
      or (a.parent_item_id is null and a.lot_seq = old.lot_seq
          and app.product_serial(a.sku,a.lot_seq) = app.product_serial(old.sku,old.lot_seq))
    )
    for update
  loop
    update app.items set
      parent_item_id = new.id,
      status = new.status,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      returned_on = new.returned_on,
      sales_channel = new.sales_channel,
      condition = new.condition,
      sold_on = new.sold_on,
      sold_price = new.sold_price,
      payout_amount = new.payout_amount,
      sku = app.accessory_sku_for_parent(new.sku, accessory.sku),
      lot_seq = new.lot_seq,
      deliverer_id = new.deliverer_id
    where id = accessory.id;
  end loop;
  return new;
end;
$function$
;


-- ▼▼▼ 20261027205732_marketplace_accessory_receipt_readiness.sql ▼▼▼

-- Receipt-only readiness. Tracking continues to use the unchanged exact-one probe.
create or replace function app.marketplace_receipt_context(p_marketplace app.marketplace,p_item_id text)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare v_probe jsonb; v_items jsonb;
begin
  v_probe=app.marketplace_extension_probe(p_marketplace,p_item_id);
  select coalesce(jsonb_agg(e.value || jsonb_build_object(
    'receipt_ready', (i.inspected_at is not null and i.cleaned_at is not null) or
      (i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null),
    'receipt_source', case when i.inspected_at is not null and i.cleaned_at is not null then 'own'
      when i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null then 'parent' else null end,
    'receipt_parent_sku', case when i.is_accessory and p.id is not null and not p.is_accessory then p.sku else null end
  ) order by i.id),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_probe->'items') e(value)
  join app.items i on i.id=(e.value->>'id')::uuid
  left join app.items p on i.is_accessory and p.id=i.parent_item_id;
  return v_probe || jsonb_build_object('items',v_items);
end $$;
revoke all on function app.marketplace_receipt_context(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_receipt_context(app.marketplace,text) to authenticated;

CREATE OR REPLACE FUNCTION app.marketplace_extension_receipt(p_action text, p_marketplace app.marketplace, p_item_id text, p_account_label text, p_token uuid DEFAULT NULL::uuid, p_details text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare v_market text; v_probe jsonb; v_row app.marketplace_extension_receipts%rowtype; v_token uuid;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です'; end if;
  if p_action not in ('reserve','begin','complete','unknown','release') then raise exception '操作が不正です'; end if;
  if nullif(trim(p_account_label),'') is null or length(p_account_label)>200 then raise exception 'アカウント識別が必要です'; end if;
  v_probe=app.marketplace_receipt_context(p_marketplace,p_item_id);
  v_market=case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end;
  perform pg_advisory_xact_lock(hashtextextended(v_market||':'||p_item_id,0));
  select * into v_row from app.marketplace_extension_receipts where marketplace=v_market and marketplace_item_id=p_item_id for update;
  if p_action='reserve' then
    if (v_probe->>'count')::int<>1 then return jsonb_build_object('eligible',false,'reason','在庫1件一致が必要です'); end if;
    if coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then return jsonb_build_object('eligible',false,'reason','検品・清掃の記録待ち'); end if;
    if v_row.state is not null then return jsonb_build_object('eligible',false,'reason','既存の評価記録: '||v_row.state); end if;
    insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
      values(v_market,p_item_id,p_account_label,'reserved',auth.uid()) returning token into v_token;
    return jsonb_build_object('eligible',true,'token',v_token,'sku',v_probe->'items'->0->>'sku');
  end if;
  if v_row.token is distinct from p_token or v_row.reserved_by is distinct from auth.uid() or v_row.account_label<>p_account_label then raise exception '評価予約が一致しません'; end if;
  if p_action='begin' then
    if v_row.state<>'reserved' or v_row.reserved_at<now()-interval '5 minutes' then raise exception '評価予約が期限切れか送信済みです'; end if;
    if (v_probe->>'count')::int<>1 or coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then raise exception '評価条件が変わりました'; end if;
    update app.marketplace_extension_receipts set state='submitting',updated_at=now() where token=p_token;
  elsif p_action='release' then
    if v_row.state<>'reserved' then raise exception '送信開始後は予約を解除できません'; end if;
    delete from app.marketplace_extension_receipts where token=p_token;
  elsif p_action in ('complete','unknown') then
    if v_row.state not in ('submitting','unknown') then raise exception '送信状態が不正です'; end if;
    update app.marketplace_extension_receipts set state=case when p_action='complete' then 'succeeded' else 'unknown' end,details=left(p_details,2000),updated_at=now() where token=p_token;
  end if;
  return jsonb_build_object('ok',true);
end $function$


-- ▼▼▼ 20261027213127_marketplace_receipt_purchase_groups.sql ▼▼▼

-- Receipt-only readiness. Tracking continues to use the unchanged exact-one probe.
create or replace function app.marketplace_receipt_context(p_marketplace app.marketplace,p_item_id text)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare v_probe jsonb; v_items jsonb; v_group_ok boolean; v_source_ready boolean; v_representative jsonb; v_skus jsonb; v_count integer;
begin
  v_probe=app.marketplace_extension_probe(p_marketplace,p_item_id);
  select coalesce(jsonb_agg(e.value || jsonb_build_object(
    'receipt_ready', (i.inspected_at is not null and i.cleaned_at is not null) or
      (i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null),
    'receipt_source', case when i.inspected_at is not null and i.cleaned_at is not null then 'own'
      when i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null then 'parent' else null end,
    'receipt_parent_sku', case when i.is_accessory and p.id is not null and not p.is_accessory then p.sku else null end
  ) order by i.id),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_probe->'items') e(value)
  join app.items i on i.id=(e.value->>'id')::uuid
  left join app.items p on i.is_accessory and p.id=i.parent_item_id;
  v_count=jsonb_array_length(v_items);
  if p_marketplace='ヤフオク' and v_count between 2 and 40 then
    with members as (
      select e.value,i.is_accessory,
        coalesce((e.value->>'receipt_ready')::boolean,false) as ready,
        i.is_accessory and i.parent_item_id is not null and exists(
          select 1 from app.spare_accessories s
          where s.marketplace_item_id=p_item_id and s.marketplace='ヤフオク'
          and (s.used_for_item_id=i.parent_item_id or exists(
            select 1 from app.spare_shipping_tasks t
            where t.spare_id=s.id and t.accessory_item_id=i.id and t.item_id=i.parent_item_id
          ))
        ) as allocated
      from jsonb_array_elements(v_items) e(value)
      join app.items i on i.id=(e.value->>'id')::uuid
    )
    select bool_and(ready or allocated),bool_or(ready and not allocated),
      jsonb_agg(value->>'sku' order by value->>'sku'),
      (select value from members where ready and not allocated order by is_accessory,value->>'id' limit 1)
      into v_group_ok,v_source_ready,v_skus,v_representative from members;
    if v_group_ok and v_source_ready and v_representative is not null then
      return v_probe || jsonb_build_object('inventory_count',v_count,'count',1,
        'items',jsonb_build_array(v_representative),'receipt_group_size',v_count,
        'receipt_group_skus',v_skus,'receipt_group_basis','same_yahoo_purchase_verified_source_and_allocation');
    end if;
  end if;
  return v_probe || jsonb_build_object('items',v_items);
end $$;
revoke all on function app.marketplace_receipt_context(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_receipt_context(app.marketplace,text) to authenticated;


-- ▼▼▼ 20261027213842_formalize_marketplace_extension_probe.sql ▼▼▼

-- Preserve the live tracking probe; bootstrap its existing definition on fresh databases.
do $bootstrap$
begin
 if to_regprocedure('app.marketplace_extension_probe(app.marketplace,text)') is null then
  execute $definition$
  create function app.marketplace_extension_probe(p_marketplace app.marketplace,p_item_id text)
  returns jsonb language plpgsql security invoker set search_path=app,public as $body$
  declare v_items jsonb;
  begin
   if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です';end if;
   if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or nullif(trim(p_item_id),'') is null or length(p_item_id)>100 then raise exception '照合条件が不正です';end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',id,'sku',sku,'marketplace',marketplace,'tracking_no',tracking_no,'inspected_at',inspected_at,'cleaned_at',cleaned_at)),'[]'::jsonb)
    into v_items from app.items
    where marketplace_item_id=p_item_id and (marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and marketplace in ('ヤフフリ','PayPayフリマ')));
   return jsonb_build_object('items',v_items,'count',jsonb_array_length(v_items));
  end $body$;
  $definition$;
 end if;
end $bootstrap$;
revoke all on function app.marketplace_extension_probe(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_extension_probe(app.marketplace,text) to authenticated;


-- ▼▼▼ 20261027214243_formalize_marketplace_receipt_reservations.sql ▼▼▼

-- Formalize the extension's existing admin-only reservation ledger on clean databases.
alter table app.marketplace_extension_receipts enable row level security;
revoke all on app.marketplace_extension_receipts from public,anon;
grant select,insert,update,delete on app.marketplace_extension_receipts to authenticated;
do $policy$
begin
 if not exists(select 1 from pg_policies where schemaname='app' and tablename='marketplace_extension_receipts' and policyname='marketplace_extension_receipts_admin') then
  execute 'create policy marketplace_extension_receipts_admin on app.marketplace_extension_receipts for all to authenticated using(app.is_admin()) with check(app.is_admin())';
 end if;
end $policy$;


-- ▼▼▼ 20261028040633_accessory_receipt_evaluation_tasks.sql ▼▼▼

-- Keep receipt work separate from the accessory's actual inspection history.
create function app.receipt_purchase_market(p_marketplace app.marketplace)
returns text language sql immutable strict set search_path='' as $$
 select case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end
$$;
revoke all on function app.receipt_purchase_market(app.marketplace) from public,anon;
grant execute on function app.receipt_purchase_market(app.marketplace) to authenticated,service_role;

create function app.enqueue_accessory_receipt_tasks(p_parent_id uuid,p_requested_at timestamptz)
returns void language sql security definer set search_path='' as $$
 insert into app.receipt_evaluation_tasks(item_id,requested_at)
 select i.id,p_requested_at from app.items i join app.items parent on parent.id=i.parent_item_id
 where parent.id=p_parent_id and not parent.is_accessory and i.is_accessory and i.id<>parent.id
 and parent.inspected_at is not null and parent.cleaned_at is not null
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and nullif(btrim(i.marketplace_item_id),'') is not null
 and row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
   is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id)
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and d.marketplace_item_id=i.marketplace_item_id
   and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
 on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null
$$;
revoke all on function app.enqueue_accessory_receipt_tasks(uuid,timestamptz) from public,anon,authenticated;

create or replace function app.enqueue_inspection_receipt_task() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.action='inspection_complete' then
  insert into app.receipt_evaluation_tasks(item_id,requested_at)
  select id,new.created_at from app.items where id=new.item_id and marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
  on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null;
  perform app.enqueue_accessory_receipt_tasks(new.item_id,new.created_at);
 end if;
 return new;
end $$;

-- Also handle a separate purchase linked after the parent's inspection.
-- Imported completion dates alone must not create receipt requests.
create function app.enqueue_linked_accessory_receipt_task() returns trigger
language plpgsql security definer set search_path='' as $$
declare requested timestamptz;
begin
 if new.is_accessory and new.parent_item_id is not null then
  select max(created_at) into requested from app.inventory_workflow_events
   where item_id=new.parent_item_id and action='inspection_complete';
  if requested is not null then perform app.enqueue_accessory_receipt_tasks(new.parent_item_id,requested);end if;
 end if;
 return new;
end $$;
revoke all on function app.enqueue_linked_accessory_receipt_task() from public,anon,authenticated;
create trigger linked_accessory_receipt_task after insert or update of parent_item_id,is_accessory,marketplace,marketplace_item_id
on app.items for each row execute function app.enqueue_linked_accessory_receipt_task();

create or replace view app.v_receipt_evaluation_tasks with(security_invoker=true) as
with eligible as (
 select t.item_id as id,t.item_id,t.requested_at,i.sku,i.lot_seq,i.title,p.model_no,i.asin,
 i.marketplace,i.marketplace_item_id,i.marketplace_url,i.is_accessory,
 row_number() over(partition by app.receipt_purchase_market(i.marketplace),
   coalesce(nullif(btrim(i.marketplace_item_id),''),i.id::text)
   order by i.is_accessory,t.requested_at,i.id) as purchase_rank
 from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id
 left join app.products p on p.id=i.product_id
 left join app.items parent on parent.id=i.parent_item_id and not parent.is_accessory and parent.id<>i.id
 where t.completed_at is null
 and ((i.inspected_at is not null and i.cleaned_at is not null)
   or (i.is_accessory and parent.inspected_at is not null and parent.cleaned_at is not null))
 and (not i.is_accessory or parent.id is null
   or row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
     is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id))
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and nullif(btrim(i.marketplace_item_id),'') is not null
   and d.marketplace_item_id=i.marketplace_item_id and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
)
select id,item_id,requested_at,sku,lot_seq,title,model_no,asin,marketplace,marketplace_item_id,marketplace_url,is_accessory
from eligible where purchase_rank=1;

create or replace function app.complete_receipt_evaluation_task(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 if not exists(select 1 from app.receipt_evaluation_tasks where item_id=p_item_id) then
  raise exception '受取評価のやることがありません' using errcode='22023';
 end if;
 update app.receipt_evaluation_tasks t
 set completed_at=coalesce(t.completed_at,clock_timestamp()),completed_by=coalesce(t.completed_by,app.current_staff_id())
 from app.items i,app.items target
 where i.id=t.item_id and target.id=p_item_id
 and (i.id=target.id or (nullif(btrim(target.marketplace_item_id),'') is not null
   and i.marketplace_item_id=target.marketplace_item_id
   and app.receipt_purchase_market(i.marketplace)=app.receipt_purchase_market(target.marketplace)));
end $$;

-- Backfill only explicitly completed, still-inspected parents; completion ledgers are preserved.
do $$declare parent record;begin
 for parent in select e.item_id,max(e.created_at) requested_at from app.inventory_workflow_events e
 join app.items i on i.id=e.item_id
 where e.action='inspection_complete' and not i.is_accessory and i.inspected_at is not null and i.cleaned_at is not null
 and exists(select 1 from app.items child where child.parent_item_id=i.id and child.is_accessory)
 group by e.item_id
 loop perform app.enqueue_accessory_receipt_tasks(parent.item_id,parent.requested_at);end loop;
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261028085229_exclude_spare_accessory_receipt_tasks.sql ▼▼▼

-- Spare allocations are internal stock transfers, not new purchases to evaluate.
create function app.receipt_item_is_spare_accessory(p_item app.items)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce((p_item).is_accessory,false) and (
  exists(select 1 from app.spare_accessories s where s.used_for_item_id=(p_item).id or s.linked_item_id=(p_item).id
   or (s.used_for_item_id=(p_item).parent_item_id and nullif(btrim((p_item).marketplace_item_id),'') is not null
    and s.marketplace_item_id=(p_item).marketplace_item_id
    and case when s.marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else s.marketplace end=app.receipt_purchase_market((p_item).marketplace)))
  or exists(select 1 from app.spare_shipping_tasks s where s.accessory_item_id=(p_item).id)
 )
$$;
revoke all on function app.receipt_item_is_spare_accessory(app.items) from public,anon;
grant execute on function app.receipt_item_is_spare_accessory(app.items) to authenticated,service_role;

create or replace function app.enqueue_accessory_receipt_tasks(p_parent_id uuid,p_requested_at timestamptz)
returns void language sql security definer set search_path='' as $$
 insert into app.receipt_evaluation_tasks(item_id,requested_at)
 select i.id,p_requested_at from app.items i join app.items parent on parent.id=i.parent_item_id
 where parent.id=p_parent_id and not parent.is_accessory and i.is_accessory and i.id<>parent.id
 and not app.receipt_item_is_spare_accessory(i)
 and parent.inspected_at is not null and parent.cleaned_at is not null
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and nullif(btrim(i.marketplace_item_id),'') is not null
 and row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
   is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id)
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and d.marketplace_item_id=i.marketplace_item_id
   and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
 on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null
$$;
revoke all on function app.enqueue_accessory_receipt_tasks(uuid,timestamptz) from public,anon,authenticated;

create or replace function app.enqueue_inspection_receipt_task() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.action='inspection_complete' then
  insert into app.receipt_evaluation_tasks(item_id,requested_at)
  select i.id,new.created_at from app.items i where i.id=new.item_id and not app.receipt_item_is_spare_accessory(i) and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
  on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null;
  perform app.enqueue_accessory_receipt_tasks(new.item_id,new.created_at);
 end if;
 return new;
end $$;

-- Existing pending rows are hidden without erasing their history.
create or replace view app.v_receipt_evaluation_tasks with(security_invoker=true) as
with eligible as (
 select t.item_id as id,t.item_id,t.requested_at,i.sku,i.lot_seq,i.title,p.model_no,i.asin,
 i.marketplace,i.marketplace_item_id,i.marketplace_url,i.is_accessory,
 row_number() over(partition by app.receipt_purchase_market(i.marketplace),
   coalesce(nullif(btrim(i.marketplace_item_id),''),i.id::text)
   order by i.is_accessory,t.requested_at,i.id) as purchase_rank
 from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id
 left join app.products p on p.id=i.product_id
 left join app.items parent on parent.id=i.parent_item_id and not parent.is_accessory and parent.id<>i.id
 where t.completed_at is null and not app.receipt_item_is_spare_accessory(i)
 and ((i.inspected_at is not null and i.cleaned_at is not null)
   or (i.is_accessory and parent.inspected_at is not null and parent.cleaned_at is not null))
 and (not i.is_accessory or parent.id is null
   or row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
     is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id))
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and nullif(btrim(i.marketplace_item_id),'') is not null
   and d.marketplace_item_id=i.marketplace_item_id and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
)
select id,item_id,requested_at,sku,lot_seq,title,model_no,asin,marketplace,marketplace_item_id,marketplace_url,is_accessory
from eligible where purchase_rank=1;

create or replace function app.complete_receipt_evaluation_task(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 if exists(select 1 from app.items i where i.id=p_item_id and app.receipt_item_is_spare_accessory(i)) then
  raise exception '予備・付属品から割り当てた付属品は受取評価の対象外です' using errcode='22023';
 end if;
 if not exists(select 1 from app.receipt_evaluation_tasks where item_id=p_item_id) then
  raise exception '受取評価のやることがありません' using errcode='22023';
 end if;
 update app.receipt_evaluation_tasks t
 set completed_at=coalesce(t.completed_at,clock_timestamp()),completed_by=coalesce(t.completed_by,app.current_staff_id())
 from app.items i,app.items target
 where i.id=t.item_id and target.id=p_item_id
 and (i.id=target.id or (nullif(btrim(target.marketplace_item_id),'') is not null
   and i.marketplace_item_id=target.marketplace_item_id
   and app.receipt_purchase_market(i.marketplace)=app.receipt_purchase_market(target.marketplace)));
end $$;

notify pgrst,'reload schema';


-- ▼▼▼ 20261028110000_delivery_malfunction_reply_entry.sql ▼▼▼

-- Keep the reply entry available after notice acknowledgement, but only for an actual reply.
-- Reuse the notice definition: an admin/purchaser comment after the latest malfunction report.
do $$declare definition text;begin
 definition:=regexp_replace(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),';\s*$','');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as
 select v.*,exists(
  select 1 from app.item_comments c join app.staff s on s.id=c.author_id
  where c.item_id=v.id and c.created_at>v.malfunction_reported_at
   and s.role in (''admin'',''purchaser'')
 ) as has_malfunction_reply from ('||definition||') v';
end $$;
notify pgrst,'reload schema';


-- ▼▼▼ 20261029163356_accessory_parent_inventory_groups.sql ▼▼▼

-- Group delivery accessories by their recorded parent, while retaining legacy serial groups.
-- Both page readers remain security invoker; only parents visible in the same raw view can join.
do $migration$
declare definition text; function_name text; old_serial text:=$old$coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq')$old$;
 new_serial text:=$new$coalesce(case when $1='delivery' then lower(substring(parent.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')) end,lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq')$new$;
begin
 foreach function_name in array array['app.read_inventory_page(text,jsonb,integer,jsonb)','app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)'] loop
  definition:=pg_get_functiondef(function_name::regprocedure);
  if position('inventory_group_serial' in definition)>0 then continue;end if;
  if position(old_serial in definition)=0 or position('from raw r left join origins o' in definition)=0 or position('''original_marketplace_item_id'',o.item_id' in definition)=0 then raise exception 'Parent grouping insertion point missing: %',function_name;end if;
  definition:=replace(definition,'''original_marketplace_item_id'',o.item_id',
   '''inventory_group_serial'','||new_serial||',''original_marketplace_item_id'',o.item_id');
  -- Only the serial expression in the data CTE has the exact original form.
  definition:=replace(definition,old_serial||' serial',new_serial||' serial');
  definition:=replace(definition,'from raw r left join origins o',$join$from raw r
   left join app.items relation on $1='delivery' and (r.d->>'is_accessory')::boolean and relation.id=(r.d->>'id')::uuid
   left join raw parent on parent.d->>'id'=relation.parent_item_id::text and not (parent.d->>'is_accessory')::boolean
   left join origins o$join$);
  execute definition;
 end loop;
end $migration$;


-- ▼▼▼ 20261029212623_line_shipping_readiness.sql ▼▼▼

-- Prevent unconfigured LINE notifications from being deferred until after a sale.
-- These replacements preserve the current RPC authorization and delivery idempotency.
do $migration$
declare source text; patched text;
begin
 source:=pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 patched:=replace(source,$old$reason:=case when p.model_photo_id is null$old$,$new$reason:=case when q.state='sent' then 'LINEへ送信済み'
  when exists(select 1 from app.delivery_notice_completions c where c.item_id=i.id and c.staff_id=i.deliverer_id and c.notice_id='shipping:'||q.task_id::text) then '担当者が発送依頼を完了しています。自動通知は停止しています'
  when q.state='failed' then 'LINE送信に失敗しました。設定を確認してください'
  when q.state='sending' then 'LINEへ送信中です'
  when p.model_photo_id is null$new$);
 if patched=source then raise exception 'LINE context status anchor changed';end if;
 patched:=replace(patched,$old$'overviewPhotoId',p.overview_photo_id,$old$,$new$'requiresPhotos',coalesce((select enabled from app.delivery_line_settings where singleton),false)
   and i.sales_channel in ('メルカリ','ヤフオク') and exists(select 1 from app.delivery_line_links l join app.staff s on s.id=l.staff_id and s.is_active where l.staff_id=i.deliverer_id and not l.blocked),
  'photosReady',exists(select 1 from app.item_photos f join app.item_photos m on m.id=p.model_photo_id and coalesce(m.photo_kind,'product')='product' where f.id=p.overview_photo_id and coalesce(f.photo_kind,'product')='product'),
  'overviewPhotoId',p.overview_photo_id,$new$);
 execute patched;
 source:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 patched:=regexp_replace(source,$old$if[[:space:]]+i[.]status[[:space:]]*<>[[:space:]]*'商品登録前'[[:space:]]+then$old$,$new$
    IF coalesce((app.line_shipping_context(i.id)->>'requiresPhotos')::boolean,false)
      AND NOT coalesce((app.line_shipping_context(i.id)->>'photosReady')::boolean,false) THEN
      RAISE EXCEPTION '出品前にLINE発送依頼の全体写真と型番確認写真を保存してください';
    END IF;
    IF i.status <> '商品登録前' THEN$new$,'i');
 if patched=source then raise exception 'Listing readiness anchor changed';end if;
 execute patched;
 -- Include LINE preparation failures immediately, without waiting for the 24-hour reminder.
 source:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(source,$old$i.marketplace_url,t.created_at from app.delivery_shipping_tasks t$old$,$new$i.marketplace_url,t.created_at,case when lc.value->>'state' in ('pending','sending','failed') then lc.value->>'message' end as line_message from app.delivery_shipping_tasks t$new$);
 if patched=source then raise exception 'Shipping reminder projection anchor changed';end if;
 patched:=replace(patched,$old$from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id$old$,$new$from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id left join lateral(select app.line_shipping_context(i.id) value) lc on true$new$);
 if position('left join lateral(select app.line_shipping_context(i.id) value) lc' in patched)=0 then raise exception 'Shipping reminder join anchor changed';end if;
 source:=patched;
 patched:=replace(patched,$old$t.created_at<=now()-interval '24 hours'$old$,$new$(t.created_at<=now()-interval '24 hours' or lc.value->>'state' in ('pending','sending','failed'))$new$);
 if patched=source then raise exception 'Shipping reminder delay anchor changed';end if;
 execute patched;
end $migration$;


-- ▼▼▼ 20261030002132_automatic_line_notifications.sql ▼▼▼

-- Shipping requests are notifications, not a prerequisite for listing.
-- Keep the ordinary listing approval and operation-id protections.
do $migration$
declare source text;patched text;
begin
 source:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 patched:=replace(source,$gate$IF coalesce((app.line_shipping_context(i.id)->>'requiresPhotos')::boolean,false)
      AND NOT coalesce((app.line_shipping_context(i.id)->>'photosReady')::boolean,false) THEN
      RAISE EXCEPTION '出品前にLINE発送依頼の全体写真と型番確認写真を保存してください';
    END IF;$gate$,'');
 if source=patched then raise exception 'Listing LINE gate anchor changed';end if;
 execute patched;
 source:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(source,$old$,case when lc.value->>'state' in ('pending','sending','failed') then lc.value->>'message' end as line_message$old$,'');
 patched:=replace(patched,' left join lateral(select app.line_shipping_context(i.id) value) lc on true','');
 patched:=replace(patched,$old$(t.created_at<=now()-interval '24 hours' or lc.value->>'state' in ('pending','sending','failed'))$old$,$new$t.created_at<=now()-interval '24 hours'$new$);
 if source=patched or position('lc.value' in patched)>0 then raise exception 'Shipping reminder rollback anchor changed';end if;
 execute patched;
 -- Cached clients must also release the withdrawn listing restriction.
 source:=pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 patched:=replace(source,$old$'requiresPhotos',coalesce((select enabled from app.delivery_line_settings where singleton),false)
   and i.sales_channel in ('メルカリ','ヤフオク') and exists(select 1 from app.delivery_line_links l join app.staff s on s.id=l.staff_id and s.is_active where l.staff_id=i.deliverer_id and not l.blocked),$old$,$new$'requiresPhotos',false,$new$);
 patched:=replace(patched,$old$when exists(select 1 from app.delivery_notice_completions c where c.item_id=i.id and c.staff_id=i.deliverer_id and c.notice_id='shipping:'||q.task_id::text) then '担当者が発送依頼を完了しています。自動通知は停止しています'$old$,'');
 if source=patched then raise exception 'LINE context rollback anchor changed';end if;
 execute patched;
end $migration$;

-- Acknowledge/hide in-app cards independently from sending a shipping request.
-- Explicitly cancelled requests (including a user's no-reissue instruction) stay cancelled.
create or replace function app.line_shipping_eligible(p_id uuid) returns boolean
language sql stable set search_path='' as $$
 select coalesce((select not l.blocked and s.is_active and s.id=i.deliverer_id
  and o.state<>'cancelled' and t.resolved_at is null and i.status='取引中' and i.shipped_on is null
  and i.sold_on is null and i.seller_cancelled_at is null
  and (i.sales_channel='自己発送' or (i.sales_channel in ('メルカリ','ヤフオク') and o.trade_key=i.seller_trade_key
   and exists(select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key and sl.channel=i.sales_channel)))
 from app.delivery_line_outbox o join app.delivery_line_links l on l.id=o.link_id join app.staff s on s.id=l.staff_id
 join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id where o.id=p_id),false);
$$;

create or replace function app.line_shipping_media(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('itemId',i.id,'serial',app.product_serial(i.sku,i.lot_seq),'sku',i.sku,
  'supplierUrl',i.marketplace_url,'automatic',true,
  'photoPaths',case when front.id is not null and model.id is not null then jsonb_build_array(front.storage_path,model.storage_path)
   else coalesce((select jsonb_agg(f.storage_path order by f.created_at,f.id) from
    (select p.storage_path,p.created_at,p.id from app.item_photos p where p.item_id=i.id and coalesce(p.photo_kind,'product')='product'
     and p.storage_path ~* '\.(jpe?g|png)$' order by p.created_at,p.id limit 2) f),'[]'::jsonb) end,
  'codeOperationId',code.id)
 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id
 left join app.delivery_line_preferences pref on pref.item_id=i.id
 left join app.item_photos front on front.id=pref.overview_photo_id and coalesce(front.photo_kind,'product')='product'
 left join app.item_photos model on model.id=pref.model_photo_id and coalesce(model.photo_kind,'product')='product'
 left join lateral(select op.id from app.seller_operations op join app.seller_listings sl on sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key
  where op.item_id=i.id and op.account_id=sl.account_id and op.channel=sl.channel and op.kind in ('shipping_code','register_package')
   and op.status='succeeded' and op.payload->>'trade_key'=o.trade_key and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null order by op.created_at desc limit 1) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id);
$$;

-- Fill only current, unshipped work. Never reset sent/cancelled rows or their retry keys.
create function app.ensure_line_shipping_requests(p_staff uuid default null) returns integer
language plpgsql security definer set search_path='' as $$
declare queued integer;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return 0;end if;
 insert into app.delivery_line_outbox(task_id,link_id,trade_key)
 select t.id,l.id,i.seller_trade_key from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
 join app.staff s on s.id=i.deliverer_id and s.is_active join app.delivery_line_links l on l.staff_id=s.id and not l.blocked
 where t.resolved_at is null and i.status='取引中' and i.shipped_on is null and i.sold_on is null and i.seller_cancelled_at is null
  and (p_staff is null or s.id=p_staff)
  and (i.sales_channel='自己発送' or (i.sales_channel in ('メルカリ','ヤフオク') and i.seller_trade_key is not null
   and exists(select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active and sl.channel=i.sales_channel and sl.trade_key=i.seller_trade_key)))
 on conflict do nothing;
 get diagnostics queued=row_count;
 update app.delivery_line_outbox o set trade_key=i.seller_trade_key from app.delivery_shipping_tasks t,app.items i
 where o.task_id=t.id and t.item_id=i.id and o.trade_key is null and o.state='pending' and o.attempts=0
  and i.seller_trade_key is not null and t.resolved_at is null and (p_staff is null or i.deliverer_id=p_staff);
 return queued;
end $$;
revoke all on function app.ensure_line_shipping_requests(uuid) from public,anon,authenticated;
grant execute on function app.ensure_line_shipping_requests(uuid) to service_role;

create or replace function app.capture_delivery_line_shipping() returns trigger
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
 if tg_table_name='delivery_shipping_tasks' or tg_table_name='seller_listings' then
  select deliverer_id into target from app.items where id=new.item_id;
 else target:=new.deliverer_id;end if;
 perform app.ensure_line_shipping_requests(target);
 perform app.kick_delivery_line();
 return new;
end $$;
create trigger seller_listings_line_shipping after insert or update of active,trade_key on app.seller_listings
 for each row execute function app.capture_delivery_line_shipping();
create trigger items_line_trade_ready after update of seller_trade_key on app.items
 for each row when(old.seller_trade_key is distinct from new.seller_trade_key) execute function app.capture_delivery_line_shipping();

-- A newly connected staff member receives their current waiting work too.
do $migration$
declare source text;patched text;
begin
 source:=pg_get_functiondef('app.handle_delivery_line_event(text,text,text,text)'::regprocedure);
 patched:=replace(source,' return true;', ' perform app.ensure_line_shipping_requests(target); perform app.kick_delivery_line(); return true;');
 if source=patched then raise exception 'LINE linking anchor changed';end if;
 execute patched;
 source:=pg_get_functiondef('app.extension_prepare_line_shipping(text[])'::regprocedure);
 patched:=replace(source,$old$for o in select q.id$old$,$new$perform app.ensure_line_shipping_requests();
 for o in select q.id$new$);
 -- Code preparation may continue when settings are present, but is never a notification gate.
 patched:=replace(patched,'if app.line_shipping_media(o.id) is not null then continue;end if;',
  $new$if app.line_shipping_media(o.id)->>'codeOperationId' is not null then continue;end if;$new$);
 if source=patched then raise exception 'LINE patrol anchor changed';end if;
 execute patched;
end $migration$;

-- Admin repair uses the same queue and retry keys; it never reissues sent requests.
create function app.refresh_delivery_line_shipping() returns integer
language plpgsql security definer set search_path='' as $$
declare queued integer;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者のみ操作できます' using errcode='42501';end if;
 queued:=app.ensure_line_shipping_requests();perform app.kick_delivery_line();return queued;
end $$;
revoke all on function app.refresh_delivery_line_shipping() from public,anon;
grant execute on function app.refresh_delivery_line_shipping() to authenticated;


-- ▼▼▼ 20261031100618_accessory_usage_reassignment.sql ▼▼▼

-- Usage changes move the same accessory record, preserving purchase/media/history IDs.
-- A dedicated RPC must not redirect those edits into either main product.
do $migration$
declare source text;patched text;
begin
 source:=pg_get_functiondef('app.redirect_accessory_shared_edits()'::regprocedure);
 patched:=regexp_replace(source,'begin',
  $guard$begin
  if old.id::text=current_setting('app.reassigning_accessory_id',true) and new.parent_item_id is distinct from old.parent_item_id then return new;end if;$guard$,'i');
 if source=patched then raise exception 'Accessory redirect anchor changed';end if;
 execute patched;
end $migration$;

-- Reconcile the deployed helper: retain each accessory's purchase tail and
-- suffix. The old migration-only implementation collapsed uppercase serials.
create or replace function app.accessory_sku_for_parent(p_parent_sku text,p_accessory_sku text)
returns text language plpgsql immutable set search_path='' as $$
declare
 parent_numeric text:=coalesce((regexp_match(p_parent_sku,'^([0-9]+)'))[1],'');
 accessory_serial text:=lower(coalesce((regexp_match(p_accessory_sku,'^([0-9]+[a-z]*)[-_]'))[1],''));
 accessory_letters text:=coalesce((regexp_match(accessory_serial,'^[0-9]+([a-z]*)$'))[1],'');
 tail text;
begin
 if parent_numeric='' then return p_parent_sku;end if;
 tail:=coalesce(substring(p_accessory_sku from '[-_].*$'),substring(p_parent_sku from '[-_].*$'));
 return parent_numeric||accessory_letters||tail;
end $$;

-- Parent/accessory amounts mirror one sale. Preserve the deployed parent
-- exception in both directions so later corrections do not see a second sale.
-- Unlinked accessories and other main products still use the duplicate guard.
create or replace function app.guard_single_product_sale() returns trigger
language plpgsql set search_path='' as $$
declare serial_key text;
begin
 if tg_op='UPDATE' and new.sold_on is not distinct from old.sold_on
  and new.sold_price is not distinct from old.sold_price
  and new.payout_amount is not distinct from old.payout_amount then return new;end if;
 if new.sold_on is null then return new;end if;
 if new.is_accessory and app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0 then return new;end if;
 serial_key:=app.product_serial(new.sku,new.lot_seq);
 perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
 if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key
  and i.id<>new.id
  and not coalesce(new.is_accessory and i.id=new.parent_item_id,false)
  and not coalesce(i.is_accessory and i.parent_item_id=case when new.is_accessory then new.parent_item_id else new.id end
   and not app.is_standalone_accessory_serial(i.sku,i.lot_seq),false)
  and i.sold_on is not null
  and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
  and not app.is_standalone_accessory_serial(i.sku,i.lot_seq)
  and i.amazon_returned_on is null and i.returned_on is null
  and i.marketplace is distinct from 'Amazon返品' and i.status<>'返品処理') then
  raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
 end if;
 return new;
end $$;

create function app.accessory_usage_context(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare i app.items;parent app.items;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or i.id is null or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '担当する付属品のみ確認できます' using errcode='42501';end if;
 if not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体に付属する商品のみ利用記録を変更できます';end if;
 select * into parent from app.items where id=i.parent_item_id and not is_accessory;
 return jsonb_build_object('serial',lower(coalesce(app.product_serial(parent.sku,parent.lot_seq),app.product_serial(i.sku,i.lot_seq))),
  'revision',i.updated_at,'sku',i.sku);
end $$;

create function app.reassign_accessory_usage(p_item_id uuid,p_serial text,p_expected_revision timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i app.items;target app.items;original app.items;matches integer;serial text:=lower(btrim(p_serial));
 suffix text;original_serial text;tail text;candidate text;projected_sku text;attempt integer:=0;previous_marker text;middle_code text;
begin
 select * into i from app.items where id=p_item_id for update;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  or i.id is null or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id(),false) then raise exception '担当する付属品のみ変更できます' using errcode='42501';end if;
 if not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体に付属する商品のみ利用記録を変更できます';end if;
 if i.updated_at is distinct from p_expected_revision then raise exception '付属品が更新されています。画面を開き直してください' using errcode='40001';end if;
 if serial is null or serial !~ '^[1-9][0-9]*[a-z]*$' or length(serial)>32 then raise exception '使用先の通番号を入力してください';end if;
 select count(*) into matches from app.items where not is_accessory and lower(app.product_serial(sku,lot_seq))=serial;
 if matches<>1 then raise exception '使用先の本体を1件に特定できません。通番号を確認してください';end if;
 select * into target from app.items where not is_accessory and lower(app.product_serial(sku,lot_seq))=serial for update;
 if not app.is_admin() and target.deliverer_id is distinct from app.current_staff_id() then raise exception '担当外の本体には変更できません' using errcode='42501';end if;
 if target.deliverer_id is distinct from i.deliverer_id then raise exception '納品担当者が同じ本体を指定してください';end if;
 select * into original from app.items where id=i.parent_item_id and not is_accessory for update;
 if original.id is null then
  select count(*) into matches from app.items where not is_accessory and lot_seq=i.lot_seq and app.product_serial(sku,lot_seq)=app.product_serial(i.sku,i.lot_seq);
  if matches<>1 then raise exception '現在の本体を一意に確認できません';end if;
  select * into original from app.items where not is_accessory and lot_seq=i.lot_seq and app.product_serial(sku,lot_seq)=app.product_serial(i.sku,i.lot_seq) for update;
 end if;
 if target.id=original.id then return jsonb_build_object('item_id',i.id,'serial',serial,'sku',i.sku);end if;
 if i.shipped_on is not null or i.sold_on is not null or original.shipped_on is not null or original.sold_on is not null
  or target.shipped_on is not null or target.sold_on is not null or i.status='販売済' or original.status='販売済' or target.status='販売済' then
  raise exception '発送・販売完了した商品の利用記録は変更できません';end if;
 original_serial:=lower(app.product_serial(original.sku,original.lot_seq));
 suffix:=case when lower(app.product_serial(i.sku,i.lot_seq)) like original_serial||'%' then substring(lower(app.product_serial(i.sku,i.lot_seq)) from length(original_serial)+1) else '' end;
 -- Match the identity trigger's final SKU before checking collisions, even when
 -- a previous parent synchronization left a different date/cost in the old SKU.
 select coalesce((select code from app.staff where id=i.purchaser_id),'')||coalesce((select code from app.staff where id=i.deliverer_id),'') into middle_code;
 if middle_code='' then middle_code:=split_part(i.sku,'-',2);end if;
 tail:='-'||middle_code||'-'||coalesce(to_char(i.purchased_at,'YYYYMMDD'),split_part(i.sku,'-',3))||'-'||(i.cost_amount/10)::text;
 loop
  candidate:=app.return_sku_original_cost(serial||suffix||tail,target.lot_seq);
  -- Main-product updates later synchronize all accessory SKU tails. Reserve a
  -- distinct serial under that transformation too, not just today's full SKU.
  projected_sku:=app.return_sku_original_cost(app.accessory_sku_for_parent(target.sku,candidate),target.lot_seq);
  exit when not exists(select 1 from app.items where sku=candidate and id<>i.id)
   and not exists(select 1 from app.item_sku_aliases where sku in(candidate,projected_sku) and item_id<>i.id)
   and not exists(select 1 from app.items where sku=projected_sku and id<>i.id)
   and not exists(select 1 from app.items a where a.parent_item_id=target.id and a.is_accessory and a.id<>i.id
    and app.product_serial(a.sku,a.lot_seq)=app.product_serial(candidate,target.lot_seq))
   and not exists(select 1 from app.items a where a.parent_item_id=target.id and a.is_accessory and a.id<>i.id
    and app.return_sku_original_cost(app.accessory_sku_for_parent(target.sku,a.sku),target.lot_seq)=projected_sku);
  suffix:=suffix||'a';attempt:=attempt+1;
  if attempt>30 then raise exception '使用先の付属品SKUを確保できません';end if;
 end loop;
 previous_marker:=current_setting('app.reassigning_accessory_id',true);
 perform set_config('app.reassigning_accessory_id',i.id::text,true);
 update app.items set parent_item_id=target.id,lot_seq=target.lot_seq,sku=candidate,
  status=target.status,packed_on=target.packed_on,shipped_on=target.shipped_on,returned_on=target.returned_on,
  sales_channel=target.sales_channel,condition=target.condition,sold_on=target.sold_on,sold_price=target.sold_price,payout_amount=target.payout_amount
 where id=i.id;
 perform set_config('app.reassigning_accessory_id',coalesce(previous_marker,''),true);
 update app.spare_shipping_tasks set item_id=target.id,lot_seq=target.lot_seq
 where accessory_item_id=i.id and sent_at is null and completed_at is null;
 return jsonb_build_object('item_id',i.id,'serial',serial,'sku',(select sku from app.items where id=i.id));
end $$;
revoke all on function app.accessory_usage_context(uuid),app.reassign_accessory_usage(uuid,text,timestamptz) from public,anon;
grant execute on function app.accessory_usage_context(uuid),app.reassign_accessory_usage(uuid,text,timestamptz) to authenticated;


