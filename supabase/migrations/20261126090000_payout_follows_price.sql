-- 振込想定金額を、販売想定金額とAmazonの手数料に合わせ続ける（2026-11-26 ユーザー指定）。
-- 経緯：全件照合で6件がAPIの値とずれていた。5件は販売想定金額だけが後から変わり振込想定金額が古いまま残ったもの
--       （計算し直さない古い版の画面・拡張機能・手作業の書き換え）、1件はAmazonの手数料そのものが変わったもの。
-- 1. 販売想定金額を変えたのに振込想定金額が同じ、という保存をデータベースで断る（どの画面・スクリプトからでも）。
-- 2. 毎日、全商品をAmazonの手数料APIと照合し、ずれていれば振込想定金額と仕入れ目標金額（利益のルール）を直す
--    （Edge Function amazon-catalog-estimate の定期実行。直した記録は app.product_payout_changes）。

-- 変更前の控え
create table if not exists app.backup_product_payout_20261126 as
  select id, owner_staff_id, product_no, asin, list_price, payout_estimate, target_cost, target_profit_rate, now() as saved_at
    from app.products;
create table if not exists app.backup_product_option_payout_20261126 as
  select id, product_id, list_price, payout_estimate, target_cost, target_profit_rate, now() as saved_at
    from app.product_options;
revoke all on app.backup_product_payout_20261126 from public, anon, authenticated;
revoke all on app.backup_product_option_payout_20261126 from public, anon, authenticated;

-- 1. 販売想定金額だけを変える保存を断る
create or replace function app.require_payout_with_list_price()
returns trigger
language plpgsql
set search_path = pg_catalog, app
as $function$
begin
  if new.list_price is distinct from old.list_price and coalesce(new.list_price, 0) > 0
     and new.payout_estimate is not distinct from old.payout_estimate then
    raise exception '販売想定金額を変えたときは、振込想定金額もAmazonの手数料APIで計算し直して保存してください。'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;
revoke all on function app.require_payout_with_list_price() from public, anon, authenticated;

drop trigger if exists products_require_payout_with_list_price on app.products;
create trigger products_require_payout_with_list_price
  before update of list_price on app.products
  for each row execute function app.require_payout_with_list_price();
drop trigger if exists product_options_require_payout_with_list_price on app.product_options;
create trigger product_options_require_payout_with_list_price
  before update of list_price on app.product_options
  for each row execute function app.require_payout_with_list_price();

-- 2. 毎日の照合
create table if not exists app.product_payout_checks (
  kind text not null check (kind in ('product', 'option')),
  target_id uuid not null,
  checked_at timestamptz not null default now(),
  error text,
  primary key (kind, target_id)
);
create table if not exists app.product_payout_changes (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('product', 'option')),
  target_id uuid not null,
  asin text,
  list_price bigint,
  old_payout bigint,
  new_payout bigint,
  old_target bigint,
  new_target bigint,
  changed_at timestamptz not null default now()
);
alter table app.product_payout_checks enable row level security;
alter table app.product_payout_changes enable row level security;
revoke all on app.product_payout_checks from public, anon, authenticated;
revoke all on app.product_payout_changes from public, anon, authenticated;
grant select, insert, update on app.product_payout_checks to service_role;
grant select, insert on app.product_payout_changes to service_role;

-- 照合がまだ・20時間以上前の商品（と付属品・状態の通り）を古い順に
create or replace function app.products_due_payout_check(p_limit integer)
returns table (kind text, id uuid, asin text, list_price bigint, payout_estimate bigint, target_cost bigint, target_profit_rate smallint)
language sql
stable
security definer
set search_path = pg_catalog, app
as $function$
  select t.kind, t.id, t.asin, t.list_price, t.payout_estimate, t.target_cost, t.target_profit_rate
    from (
      select 'product'::text as kind, p.id, p.asin::text as asin, p.list_price, p.payout_estimate, p.target_cost,
             p.target_profit_rate, c.checked_at
        from app.products p
        left join app.product_payout_checks c on c.kind = 'product' and c.target_id = p.id
       where p.is_active and p.list_price > 0
      union all
      select 'option', o.id, p.asin::text, o.list_price, o.payout_estimate, o.target_cost, o.target_profit_rate, c.checked_at
        from app.product_options o
        join app.products p on p.id = o.product_id
        left join app.product_payout_checks c on c.kind = 'option' and c.target_id = o.id
       where o.is_active and p.is_active and o.list_price > 0
    ) t
   where t.checked_at is null or t.checked_at < now() - interval '20 hours'
   order by t.checked_at nulls first, t.id
   limit greatest(1, least(coalesce(p_limit, 25), 60));
$function$;

create or replace function app.record_payout_check(p_kind text, p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = pg_catalog, app
as $function$
  insert into app.product_payout_checks (kind, target_id, checked_at, error)
  values (p_kind, p_id, now(), p_error)
  on conflict (kind, target_id) do update set checked_at = excluded.checked_at, error = excluded.error;
$function$;

-- 読んだ時から販売想定金額・振込・仕入れ目標が変わっていなければ直し、記録を残す
create or replace function app.apply_payout_correction(
  p_kind text, p_id uuid, p_list_price bigint, p_old_payout bigint, p_old_target bigint, p_payout bigint, p_target bigint)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, app
as $function$
declare
  v_asin text;
begin
  if p_payout is null or p_payout < 0 or p_payout > p_list_price then
    return false;
  end if;
  if p_kind = 'product' then
    update app.products
       set payout_estimate = p_payout, target_cost = p_target
     where id = p_id and is_active and list_price = p_list_price
       and payout_estimate is not distinct from p_old_payout and target_cost is not distinct from p_old_target
    returning asin::text into v_asin;
  elsif p_kind = 'option' then
    update app.product_options o
       set payout_estimate = p_payout, target_cost = p_target
     where o.id = p_id and o.is_active and o.list_price = p_list_price
       and o.payout_estimate is not distinct from p_old_payout and o.target_cost is not distinct from p_old_target
    returning (select p.asin::text from app.products p where p.id = o.product_id) into v_asin;
  else
    return false;
  end if;
  if not found then
    return false;
  end if;
  insert into app.product_payout_changes (kind, target_id, asin, list_price, old_payout, new_payout, old_target, new_target)
  values (p_kind, p_id, v_asin, p_list_price, p_old_payout, p_payout, p_old_target, p_target);
  return true;
end;
$function$;

revoke all on function app.products_due_payout_check(integer) from public, anon, authenticated;
revoke all on function app.record_payout_check(text, uuid, text) from public, anon, authenticated;
revoke all on function app.apply_payout_correction(text, uuid, bigint, bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function app.products_due_payout_check(integer) to service_role;
grant execute on function app.record_payout_check(text, uuid, text) to service_role;
grant execute on function app.apply_payout_correction(text, uuid, bigint, bigint, bigint, bigint, bigint) to service_role;

-- 10分ごとに25件ずつ（照合が20時間以内の商品は飛ばすので、1日に全商品を1回ずつ見る）
do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'product-payout-daily-check') then
    perform cron.unschedule('product-payout-daily-check');
  end if;
  perform cron.schedule('product-payout-daily-check', '*/10 * * * *', $job$
    with config as (
      select (select decrypted_secret from vault.decrypted_secrets where name = 'delivery_push_project_url') project_url,
             (select decrypted_secret from vault.decrypted_secrets where name = 'amazon_daily_sync_token') token
    )
    select net.http_post(
      url := rtrim(project_url, '/') || '/functions/v1/amazon-catalog-estimate',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-amazon-cron-token', token),
      body := '{"limit":25}'::jsonb,
      timeout_milliseconds := 120000
    ) from config;
  $job$);
end
$cron$;
