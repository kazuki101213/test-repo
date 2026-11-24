-- 2026-11-24: 商品リストの「通り」（色違い・付属品や状態違い）。
-- ・色違い（ASINが違う）は今までどおり商品の行のまま。同じ管理者・同じ型番なら同じ番号を共有し、枝番（variant_no）を付ける。
--   表示は「352-1」「352-2」。1通りしかない番号は「352」のまま。
-- ・付属品・状態違い（ASINが同じ）は商品の行を増やさず app.product_options に持つ。
--   ASINで商品を結び付けている関数・画面（在庫・集計など）は今までどおり1行だけを見る。
-- ・色（color）と付属品・状態（variant_label）は任意。

alter table app.products
  add column if not exists color text,
  add column if not exists variant_label text,
  add column if not exists variant_no smallint not null default 1 check (variant_no between 1 and 999);

comment on column app.products.color is '色（任意）';
comment on column app.products.variant_label is '付属品・状態（任意）';
comment on column app.products.variant_no is '同じ番号の中の枝番（1から）。番号＋枝番で一意。';

alter table app.products drop constraint if exists products_product_no_key;
alter table app.products add constraint products_product_no_variant_key unique (product_no, variant_no);

create table if not exists app.product_options (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references app.products(id) on delete cascade,
  variant_no         smallint not null check (variant_no between 1 and 999),
  label              text not null check (btrim(label) <> ''),
  list_price         bigint check (list_price >= 0),
  payout_estimate    bigint check (payout_estimate >= 0),
  target_cost        bigint check (target_cost >= 0),
  target_profit_rate smallint check (target_profit_rate between 0 and 99),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table app.product_options is '同じASINで付属品・状態が違う通り。金額は通りごと。';

create index if not exists product_options_product_idx on app.product_options (product_id);
create unique index if not exists product_options_label_key
  on app.product_options (product_id, lower(btrim(label))) where is_active;

alter table app.product_options enable row level security;
create policy product_options_select on app.product_options for select to authenticated using (true);
create policy product_options_write on app.product_options for all to authenticated
  using (app.current_role() = any (array['admin'::app.staff_role, 'purchaser'::app.staff_role]))
  with check (app.current_role() = any (array['admin'::app.staff_role, 'purchaser'::app.staff_role]));
grant select, insert, update, delete on app.product_options to authenticated;

-- 型番のそろえ方（全角・大文字小文字・前後の空白を無視）
create or replace function app.product_model_key(p_model text)
returns text
language sql
immutable
set search_path = pg_catalog
as $function$
  select upper(btrim(regexp_replace(normalize(coalesce(p_model, ''), NFKC), '\s+', ' ', 'g')));
$function$;
grant execute on function app.product_model_key(text) to authenticated;

-- 同じ番号の中の次の枝番（商品の行と付属品・状態の通りの両方を見る）
create or replace function app.next_product_variant_no(p_product_no integer)
returns smallint
language sql
stable
security definer
set search_path = pg_catalog, app
as $function$
  select (greatest(
    coalesce((select max(variant_no) from app.products where product_no = p_product_no), 0),
    coalesce((select max(o.variant_no) from app.product_options o join app.products p on p.id = o.product_id
               where p.product_no = p_product_no), 0)) + 1)::smallint;
$function$;
revoke all on function app.next_product_variant_no(integer) from public, anon, authenticated;

-- 新しい商品の番号：同じ管理者・同じ型番の商品があればその番号の次の枝番、なければ今までどおりメーカーの最後の次。
-- 古い版の拡張機能（番号を送らない）で登録しても同じになる。
create or replace function app.assign_product_catalog_number()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $function$
declare
  v_key text;
  v_last integer;
  v_max integer;
  v_same integer;
begin
  if tg_level = 'STATEMENT' then
    perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));
    return null;
  end if;

  if app.product_model_key(new.model_no) <> '' then
    select min(product_no) into v_same from app.products
     where is_active and owner_staff_id = new.owner_staff_id and product_no is not null
       and app.product_model_key(model_no) = app.product_model_key(new.model_no);
    if v_same is not null then
      new.product_no := v_same;
      new.variant_no := app.next_product_variant_no(v_same);
      return new;
    end if;
  end if;

  new.variant_no := 1;
  select greatest(coalesce(max(product_no), 0), 0) into v_max from app.products;
  v_key := app.product_maker_key(new.maker);
  if v_key <> '' then
    select max(product_no) into v_last from app.products where app.product_maker_key(maker) = v_key;
  end if;

  if v_last is null or v_last >= v_max then
    new.product_no := v_max + 1;
    return new;
  end if;

  perform app.shift_product_numbers(v_last + 1, 1);
  new.product_no := v_last + 1;
  return new;
end;
$function$;
revoke all on function app.assign_product_catalog_number() from public, anon, authenticated;

-- 付属品・状態の通り：枝番を付け、同じASINの本体の行と同じ付属品・状態なら登録済みとして止める。
create or replace function app.assign_product_option_number()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, app
as $function$
declare
  v_product app.products%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));
  select * into v_product from app.products where id = new.product_id;
  if v_product.id is null or v_product.product_no is null then
    raise exception '商品が見つかりません。' using errcode = '23503';
  end if;
  new.label := btrim(new.label);
  if lower(coalesce(btrim(v_product.variant_label), '')) = lower(new.label) then
    raise exception '%-%で登録済みです。', v_product.product_no, v_product.variant_no using errcode = '23505';
  end if;
  if tg_op = 'INSERT' then
    new.variant_no := app.next_product_variant_no(v_product.product_no);
  else
    new.variant_no := old.variant_no;
    new.product_id := old.product_id;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function app.assign_product_option_number() from public, anon, authenticated;

create trigger product_options_assign_number
before insert or update on app.product_options
for each row execute function app.assign_product_option_number();

-- 番号をずらすときに枝番の一意制約に当たらないよう、今までどおり一度大きく逃がしてから戻す（関数は変更なし）。

-- 今ある同じ管理者・同じ型番の商品（15型番・33行）を、一番小さい番号にまとめる。
-- ほかの商品の番号は変えない（空いた番号は詰めない。詰めると500件以上の番号が変わるため）。
do $merge$
begin
  perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));

  create temporary table grouped on commit drop as
  select id, product_no,
         min(product_no) over (partition by owner_staff_id, app.product_model_key(model_no)) as base_no,
         row_number() over (partition by owner_staff_id, app.product_model_key(model_no) order by product_no)::smallint as new_variant
    from app.products
   where is_active and product_no is not null and app.product_model_key(model_no) <> '';

  update app.products p
     set product_no = g.base_no + 1000000000, variant_no = g.new_variant
    from grouped g
   where g.id = p.id and (g.base_no <> p.product_no or g.new_variant <> p.variant_no);
  update app.products set product_no = product_no - 1000000000 where product_no >= 1000000000;

  update app.marketplace_purchase_drafts d
     set product_no = p.product_no
    from app.products p
   where p.id = d.product_id
     and d.product_no is distinct from p.product_no;
end
$merge$;
