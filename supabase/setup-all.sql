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

