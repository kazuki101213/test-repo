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

  -- Amazon返品 は、再作業が始まるまでは「戻ってきた」印を残しておきたい。
  -- 作業チェックが 1 つでも入ったら、通常の進捗に合流させる。
  if new.status = 'Amazon返品'
     and new.arrived_on is null
     and new.product_registered_at is null
     and new.inspected_at is null
     and new.photo_uploaded_at is null
     and new.packed_on is null
     and new.shipped_on is null then
    return new;
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

create trigger items_sync_status
  before insert or update of arrived_on, product_registered_at, inspected_at,
                             photo_uploaded_at, packed_on, shipped_on, listed_on
  on app.items
  for each row execute function app.items_sync_status();

-- 販売登録時に status を 販売済 に倒す
create or replace function app.items_mark_sold()
returns trigger
language plpgsql
as $$
begin
  if new.sold_on is not null and new.status not in ('返品処理', 'Amazon返品') then
    new.status := '販売済';
  end if;
  if new.returned_on is not null and new.status <> 'Amazon返品' then
    new.status := '返品処理';
  end if;
  return new;
end;
$$;

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
