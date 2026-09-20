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
  i.marketplace_url                 as 取引記録URL,
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


