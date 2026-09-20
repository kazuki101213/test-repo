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
