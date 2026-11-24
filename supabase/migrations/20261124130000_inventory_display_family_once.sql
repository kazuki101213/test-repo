-- 管理アプリ在庫の「さらに表示」が8秒の上限を超えて失敗していた（2026-11-24）。
-- v_inventory_display が同じ商品群の原価（v_financial_families）を、ページの1行ごとに
-- 計算し直していた（100件で約9秒）。集計を1回だけ計算するCTEにして結合する。結果は同じ。
do $$
declare
  definition text;
  anchor_with constant text := 'WITH financial_totals AS MATERIALIZED (';
  anchor_join constant text := 'LEFT JOIN app.v_financial_families family ON';
begin
  definition := pg_get_viewdef('app.v_inventory_display'::regclass, true);
  if position('financial_families AS MATERIALIZED' in definition) > 0 then
    return;
  end if;
  if position(anchor_with in definition) = 0 or position(anchor_join in definition) = 0 then
    raise exception 'v_inventory_display family anchors are missing';
  end if;
  definition := replace(definition, anchor_with,
    'WITH financial_families AS MATERIALIZED (SELECT * FROM app.v_financial_families), financial_totals AS MATERIALIZED (');
  definition := replace(definition, anchor_join, 'LEFT JOIN financial_families family ON');
  execute 'create or replace view app.v_inventory_display as ' || definition;
end $$;
