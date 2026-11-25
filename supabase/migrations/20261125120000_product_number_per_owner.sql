-- 商品リストの品番を管理者（長部一輝・石嶋俊紀など）ごとに1番から振る（2026-11-25 ユーザー指定）。
-- ・番号＋枝番の一意は「管理者・番号・枝番」にする（管理者が違えば同じ番号でよい）。
-- ・新しい商品は、同じ管理者の同じメーカーの最後の番号の次に入れ、その管理者の後ろの番号を1つずつずらす。
--   メーカーが空欄・初めてなら、その管理者の末尾（最大＋1）。同じ管理者・同じ型番なら同じ番号の次の枝番。
-- ・今ある番号は、管理者ごとに今の並び順のまま1から詰め直す。変更前の番号は app.backup_product_numbers_20261125 に残す。

-- 変更前の番号の控え
create table if not exists app.backup_product_numbers_20261125 as
  select id, owner_staff_id, product_no, variant_no, now() as saved_at from app.products;
create table if not exists app.backup_draft_product_numbers_20261125 as
  select id, product_id, product_no, now() as saved_at from app.marketplace_purchase_drafts;
revoke all on app.backup_product_numbers_20261125 from public, anon, authenticated;
revoke all on app.backup_draft_product_numbers_20261125 from public, anon, authenticated;

-- 一意制約：管理者・番号・枝番
alter table app.products drop constraint if exists products_product_no_variant_key;
alter table app.products drop constraint if exists products_owner_product_no_variant_key;
alter table app.products add constraint products_owner_product_no_variant_key unique (owner_staff_id, product_no, variant_no);

-- 番号をずらす・枝番を出すのは、その管理者の中だけ
drop function if exists app.shift_product_numbers(integer, integer);
create or replace function app.shift_product_numbers(p_owner uuid, p_from integer, p_by integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog, app
as $function$
begin
  update app.products set product_no = product_no + 1000000000 + p_by
   where owner_staff_id = p_owner and product_no >= p_from;
  update app.products set product_no = product_no - 1000000000
   where owner_staff_id = p_owner and product_no >= 1000000000;
  update app.marketplace_purchase_drafts d
     set product_no = p.product_no
    from app.products p
   where p.id = d.product_id
     and p.owner_staff_id = p_owner
     and d.product_no is distinct from p.product_no;
end;
$function$;
revoke all on function app.shift_product_numbers(uuid, integer, integer) from public, anon, authenticated;

drop function if exists app.next_product_variant_no(integer);
create or replace function app.next_product_variant_no(p_owner uuid, p_product_no integer)
returns smallint
language sql
stable
security definer
set search_path = pg_catalog, app
as $function$
  select (greatest(
    coalesce((select max(variant_no) from app.products
               where owner_staff_id = p_owner and product_no = p_product_no), 0),
    coalesce((select max(o.variant_no) from app.product_options o join app.products p on p.id = o.product_id
               where p.owner_staff_id = p_owner and p.product_no = p_product_no), 0)) + 1)::smallint;
$function$;
revoke all on function app.next_product_variant_no(uuid, integer) from public, anon, authenticated;

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

  if new.owner_staff_id is null then
    raise exception '商品リストの管理者が決まっていません。' using errcode = '23502';
  end if;

  if app.product_model_key(new.model_no) <> '' then
    select min(product_no) into v_same from app.products
     where is_active and owner_staff_id = new.owner_staff_id and product_no is not null
       and app.product_model_key(model_no) = app.product_model_key(new.model_no);
    if v_same is not null then
      new.product_no := v_same;
      new.variant_no := app.next_product_variant_no(new.owner_staff_id, v_same);
      return new;
    end if;
  end if;

  new.variant_no := 1;
  select greatest(coalesce(max(product_no), 0), 0) into v_max
    from app.products where owner_staff_id = new.owner_staff_id;
  v_key := app.product_maker_key(new.maker);
  if v_key <> '' then
    select max(product_no) into v_last from app.products
     where owner_staff_id = new.owner_staff_id and app.product_maker_key(maker) = v_key;
  end if;

  if v_last is null or v_last >= v_max then
    new.product_no := v_max + 1;
    return new;
  end if;

  perform app.shift_product_numbers(new.owner_staff_id, v_last + 1, 1);
  new.product_no := v_last + 1;
  return new;
end;
$function$;
revoke all on function app.assign_product_catalog_number() from public, anon, authenticated;

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
    new.variant_no := app.next_product_variant_no(v_product.owner_staff_id, v_product.product_no);
  else
    new.variant_no := old.variant_no;
    new.product_id := old.product_id;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function app.assign_product_option_number() from public, anon, authenticated;

-- 管理者を自動で決める trigger（products_set_catalog_owner）の後に番号を付ける。
-- 同じ BEFORE INSERT の trigger は名前の順に動くため、番号付けの名前を後ろにする。
drop trigger if exists products_assign_catalog_number on app.products;
drop trigger if exists products_zz_assign_catalog_number on app.products;
create trigger products_zz_assign_catalog_number
  before insert on app.products
  for each row when (new.product_no is null)
  execute function app.assign_product_catalog_number();

-- 今ある番号を、管理者ごとに今の並び順のまま1から詰め直す（同じ番号の枝番はそのまま）。
do $renumber$
begin
  perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));

  create temporary table renumbered on commit drop as
  select id,
         dense_rank() over (partition by owner_staff_id order by product_no)::integer as new_no
    from app.products
   where product_no is not null;

  update app.products p set product_no = r.new_no + 1000000000
    from renumbered r where r.id = p.id and r.new_no <> p.product_no;
  update app.products set product_no = product_no - 1000000000 where product_no >= 1000000000;

  update app.marketplace_purchase_drafts d
     set product_no = p.product_no
    from app.products p
   where p.id = d.product_id
     and d.product_no is distinct from p.product_no;
end
$renumber$;
