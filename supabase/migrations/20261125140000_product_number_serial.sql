-- 品番は枝番（352-1・352-2）を使わず、管理者ごとに1から1つずつの通し番号にする（2026-11-25 ユーザー指定・全員）。
-- ・色違いなど同じ型番の商品も、それぞれ別の番号（同じ型番の最後の番号の次に入れ、後ろはずらす）。
-- ・同じ型番が無ければ、今までどおり同じメーカーの最後の次、メーカーが空欄・初めてなら末尾。
-- ・付属品・状態の通り（product_options、同じASIN）は商品の行ではないので、今までどおり「番号-枝番」。
-- ・今ある番号は管理者ごとに今の並び（番号・枝番の順）のまま1から振り直す。変更前は app.backup_product_numbers_serial_20261125。

create table if not exists app.backup_product_numbers_serial_20261125 as
  select id, owner_staff_id, product_no, variant_no, now() as saved_at from app.products;
create table if not exists app.backup_draft_product_numbers_serial_20261125 as
  select id, product_id, product_no, now() as saved_at from app.marketplace_purchase_drafts;
revoke all on app.backup_product_numbers_serial_20261125 from public, anon, authenticated;
revoke all on app.backup_draft_product_numbers_serial_20261125 from public, anon, authenticated;

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
begin
  if tg_level = 'STATEMENT' then
    perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));
    return null;
  end if;

  if new.owner_staff_id is null then
    raise exception '商品リストの管理者が決まっていません。' using errcode = '23502';
  end if;

  new.variant_no := 1;
  select greatest(coalesce(max(product_no), 0), 0) into v_max
    from app.products where owner_staff_id = new.owner_staff_id;

  -- 同じ型番（色違いなど）があれば、その最後の番号の次。
  if app.product_model_key(new.model_no) <> '' then
    select max(product_no) into v_last from app.products
     where owner_staff_id = new.owner_staff_id and is_active
       and app.product_model_key(model_no) = app.product_model_key(new.model_no);
  end if;
  -- 無ければ同じメーカーの最後の番号の次。
  if v_last is null then
    v_key := app.product_maker_key(new.maker);
    if v_key <> '' then
      select max(product_no) into v_last from app.products
       where owner_staff_id = new.owner_staff_id and app.product_maker_key(maker) = v_key;
    end if;
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

do $renumber$
begin
  perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));

  create temporary table renumbered on commit drop as
  select id,
         row_number() over (partition by owner_staff_id order by product_no, variant_no, id)::integer as new_no
    from app.products
   where product_no is not null;

  update app.products p set product_no = r.new_no + 1000000000, variant_no = 1
    from renumbered r where r.id = p.id and (r.new_no <> p.product_no or p.variant_no <> 1);
  update app.products set product_no = product_no - 1000000000 where product_no >= 1000000000;

  update app.marketplace_purchase_drafts d
     set product_no = p.product_no
    from app.products p
   where p.id = d.product_id
     and d.product_no is distinct from p.product_no;
end
$renumber$;
