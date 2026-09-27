create or replace view app.v_stock_summary with (security_invoker=true) as
 SELECT count(DISTINCT lot_seq) AS "現在庫数",
    sum(cost_amount) AS "仕入金額合計",
    sum(COALESCE(planned_payout, 0::bigint)) AS "売上見込み合計",
    sum(COALESCE(planned_payout, 0::bigint) - cost_amount) AS "見込み利益合計",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) <= 7) AS "高回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 8 AND (CURRENT_DATE - purchased_at) <= 14) AS "中回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 15) AS "低回転",
    count(DISTINCT lot_seq) FILTER (WHERE status::text IN ('仕入済','入荷済','作業中')) AS "作業中",
    count(*) FILTER (WHERE status = '仕入済'::app.item_status) AS "入荷待ち"
   FROM app.items
  WHERE status <> ALL (ARRAY['販売済'::app.item_status, '返品処理'::app.item_status, '廃棄'::app.item_status]);
notify pgrst,'reload schema';
