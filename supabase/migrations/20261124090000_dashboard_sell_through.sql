-- 2026-11-24: ダッシュボード「今月販売」の保有在庫に「はけ率」を出す（ユーザー指定）。
-- はけ率＝31〜60日前（日本時間）に仕入れた本体のうち、仕入れから30日以内に売れた割合。
-- 30日が過ぎて結果が出そろった商品だけで数える。担当者側は dashboard_purchaser_ids
-- （石川秀樹の仕入れを長部一輝に含める）と同じ範囲。

create or replace function app.read_dashboard_sell_through()
returns jsonb
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  today date := (now() at time zone 'Asia/Tokyo')::date;
  mine uuid[] := app.dashboard_purchaser_ids();
begin
  if not coalesce(app.management_reports_allowed(), false) then
    raise exception '管理者でログインしてください。' using errcode = '42501';
  end if;
  return (
    with cohort as (
      select i.purchaser_id, (i.sold_on is not null and i.sold_on <= i.purchased_at + 30) as sold_in_30
      from app.items i
      where not i.is_accessory and i.purchased_at is not null
        and i.purchased_at >= today - 60 and i.purchased_at < today - 30
    )
    select jsonb_build_object(
      'from', today - 60, 'to', today - 31,
      'all', jsonb_build_object('items', count(*), 'sold', count(*) filter (where sold_in_30)),
      'mine', jsonb_build_object(
        'items', count(*) filter (where purchaser_id = any(mine)),
        'sold', count(*) filter (where sold_in_30 and purchaser_id = any(mine)))
    )
    from cohort
  );
end;
$$;

revoke all on function app.read_dashboard_sell_through() from public, anon;
grant execute on function app.read_dashboard_sell_through() to authenticated;

notify pgrst, 'reload schema';
