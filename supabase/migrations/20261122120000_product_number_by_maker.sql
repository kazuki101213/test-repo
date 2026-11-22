-- 新しい商品の品番を、同じメーカーの最後の品番の次に入れる（後ろの品番は1つずつずらす）。
-- メーカーは先頭の語を NFKC・小文字でそろえて比較する（Panasonic 白 / panasonic / SONY / Sony）。
-- メーカーが空欄・初めてのメーカーなら、これまでどおり末尾（最大＋1）。

create or replace function app.product_maker_key(p_maker text)
returns text
language sql
stable
set search_path = pg_catalog
as $function$
  select lower(split_part(btrim(regexp_replace(normalize(coalesce(p_maker, ''), NFKC), '\s+', ' ', 'g')), ' ', 1));
$function$;

revoke all on function app.product_maker_key(text) from public, anon;
grant execute on function app.product_maker_key(text) to authenticated;

-- 品番を p_from 以上だけ p_by ずらす（一意制約に当たらないよう一度大きく逃がしてから戻す）。
create or replace function app.shift_product_numbers(p_from integer, p_by integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog, app
as $function$
begin
  update app.products set product_no = product_no + 1000000000 + p_by where product_no >= p_from;
  update app.products set product_no = product_no - 1000000000 where product_no >= 1000000000;
  update app.marketplace_purchase_drafts d
     set product_no = p.product_no
    from app.products p
   where p.id = d.product_id
     and d.product_no is distinct from p.product_no;
end;
$function$;

revoke all on function app.shift_product_numbers(integer, integer) from public, anon, authenticated;

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
    -- Coordinate registrations and explicit number changes before locking any rows.
    perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));
    return null;
  end if;

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

-- 末尾に入っていた 631〜634（Panasonic 白・Panasonic・Sony・Sony）を各メーカーの一番下へ移す。
do $move$
declare
  v_ids uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended('app.products.product_no', 0));

  select array_agg(id order by product_no) into v_ids
    from app.products
   where id in ('0c79de29-fddd-4a08-b9b3-8cbb473d88a5', 'a4473bdb-e983-41fe-8c70-a83759ceb046',
                '64f95329-8001-4798-870c-3851cea8c38a', 'd0baecd8-0e2e-407a-a598-04204da46af7');
  if v_ids is null then
    return;
  end if;

  create temporary table moved_products on commit drop as
  select p.id,
         (select max(o.product_no) from app.products o
           where app.product_maker_key(o.maker) = app.product_maker_key(p.maker)
             and o.id <> all (v_ids)) + 0.5 + p.product_no / 1000000.0 as sort_key
    from app.products p
   where p.id = any (v_ids);

  if exists (select 1 from moved_products where sort_key is null) then
    raise exception 'メーカーの既存商品が見つからない商品がある';
  end if;

  create temporary table renumbered on commit drop as
  select p.id,
         case when m.id is null
              then p.product_no + (select count(*) from moved_products x where x.sort_key < p.product_no)
              else floor(m.sort_key)::integer + 1 + (select count(*) from moved_products x where x.sort_key < m.sort_key)
         end::integer as new_no
    from app.products p
    left join moved_products m on m.id = p.id;

  update app.products p set product_no = r.new_no + 1000000000
    from renumbered r where r.id = p.id and r.new_no <> p.product_no;
  update app.products set product_no = product_no - 1000000000 where product_no >= 1000000000;

  update app.marketplace_purchase_drafts d
     set product_no = p.product_no
    from app.products p
   where p.id = d.product_id
     and d.product_no is distinct from p.product_no;
end
$move$;
