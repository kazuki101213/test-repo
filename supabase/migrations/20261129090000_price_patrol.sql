-- 商品リストの価格巡回（2026-11-29 ユーザー指定）
-- 3日に1回、各商品の販売想定金額を相場に合わせる。
--   実績あり：Amazon SP-APIで今出ている中古「非常に良い」FBA出品の最安値
--   実績無し：Keepaのオファー（Prime・ほぼ新品/非常に良い/良い・最終確認60日以内）の最終確認が新しい5件の中央値
--   今の価格との差が25%以内なら上げ下げとも反映、25%を超えるときは反映しない。

create table if not exists app.price_patrol_checks (
  product_id uuid primary key references app.products(id) on delete cascade,
  source text not null check (source in ('amazon', 'keepa')),
  checked_at timestamptz not null default now(),
  market_price bigint,
  outcome text not null,
  detail jsonb,
  error text
);

create table if not exists app.price_patrol_changes (
  id bigserial primary key,
  product_id uuid not null references app.products(id) on delete cascade,
  asin text not null,
  source text not null check (source in ('amazon', 'keepa')),
  old_price bigint not null,
  new_price bigint not null,
  old_payout bigint,
  new_payout bigint,
  old_target bigint,
  new_target bigint,
  detail jsonb,
  changed_at timestamptz not null default now()
);
create index if not exists price_patrol_changes_changed_at on app.price_patrol_changes (changed_at desc);

alter table app.price_patrol_checks enable row level security;
alter table app.price_patrol_changes enable row level security;
create policy price_patrol_checks_admin_read on app.price_patrol_checks for select to authenticated
  using (app.current_role() = 'admin'::app.staff_role);
create policy price_patrol_changes_admin_read on app.price_patrol_changes for select to authenticated
  using (app.current_role() = 'admin'::app.staff_role);
grant select on app.price_patrol_checks, app.price_patrol_changes to authenticated;

-- 巡回の順番：一度も見ていない商品、前回から3日以上たった商品の順
create or replace function app.price_patrol_due(p_source text, p_limit integer)
returns table (id uuid, asin text, list_price bigint, payout_estimate bigint, target_cost bigint, target_profit_rate smallint)
language sql stable security definer set search_path to 'pg_catalog', 'app'
as $$
  select p.id, trim(p.asin)::text, p.list_price, p.payout_estimate, p.target_cost, p.target_profit_rate
    from app.products p
    left join app.price_patrol_checks c on c.product_id = p.id
   where p.is_active and p.list_price > 0 and p.asin is not null
     and p.has_sold_before = (p_source = 'amazon')
     and (c.checked_at is null or c.checked_at < now() - interval '3 days')
   order by c.checked_at nulls first, p.product_no, p.id
   limit greatest(1, least(coalesce(p_limit, 20), 60));
$$;

create or replace function app.price_patrol_record(p_product_id uuid, p_source text, p_market bigint, p_outcome text, p_detail jsonb, p_error text)
returns void
language sql security definer set search_path to 'pg_catalog', 'app'
as $$
  insert into app.price_patrol_checks (product_id, source, checked_at, market_price, outcome, detail, error)
  values (p_product_id, p_source, now(), p_market, p_outcome, p_detail, p_error)
  on conflict (product_id) do update set source = excluded.source, checked_at = excluded.checked_at,
    market_price = excluded.market_price, outcome = excluded.outcome, detail = excluded.detail, error = excluded.error;
$$;

-- 価格を書き換える。読み込んだ後に誰かが値を変えていたら書き換えない（false）。
create or replace function app.price_patrol_apply(p_product_id uuid, p_source text, p_old_price bigint, p_new_price bigint,
  p_old_payout bigint, p_new_payout bigint, p_old_target bigint, p_new_target bigint, p_detail jsonb)
returns boolean
language plpgsql security definer set search_path to 'pg_catalog', 'app'
as $$
declare v_asin text;
begin
  if p_new_price is null or p_new_price < 1 or p_new_payout is null or p_new_payout < 0 or p_new_payout > p_new_price then
    return false;
  end if;
  update app.products
     set list_price = p_new_price, payout_estimate = p_new_payout, target_cost = p_new_target
   where id = p_product_id and is_active and list_price = p_old_price
     and payout_estimate is not distinct from p_old_payout and target_cost is not distinct from p_old_target
  returning trim(asin)::text into v_asin;
  if not found then return false; end if;
  insert into app.price_patrol_changes (product_id, asin, source, old_price, new_price, old_payout, new_payout, old_target, new_target, detail)
  values (p_product_id, v_asin, p_source, p_old_price, p_new_price, p_old_payout, p_new_payout, p_old_target, p_new_target, p_detail);
  -- 毎日の振込照合で、新しい価格から改めて確認されるようにする
  delete from app.product_payout_checks where kind = 'product' and target_id = p_product_id;
  return true;
end;
$$;

-- KeepaのAPIキーはVault（keepa_api_key）に置き、巡回の関数からだけ読む
create or replace function app.price_patrol_keepa_key()
returns text
language sql stable security definer set search_path to ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'keepa_api_key' limit 1; $$;

revoke all on function app.price_patrol_due(text, integer) from public, anon, authenticated;
revoke all on function app.price_patrol_record(uuid, text, bigint, text, jsonb, text) from public, anon, authenticated;
revoke all on function app.price_patrol_apply(uuid, text, bigint, bigint, bigint, bigint, bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function app.price_patrol_keepa_key() from public, anon, authenticated;
grant execute on function app.price_patrol_due(text, integer) to service_role;
grant execute on function app.price_patrol_record(uuid, text, bigint, text, jsonb, text) to service_role;
grant execute on function app.price_patrol_apply(uuid, text, bigint, bigint, bigint, bigint, bigint, bigint, jsonb) to service_role;
grant execute on function app.price_patrol_keepa_key() to service_role;
