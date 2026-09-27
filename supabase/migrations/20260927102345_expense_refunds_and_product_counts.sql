-- Expense refunds reduce expense totals; retain existing access policies.
ALTER TABLE app.expenses DROP CONSTRAINT expenses_amount_check;
ALTER TABLE app.expenses ADD CONSTRAINT expenses_amount_check CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991);
CREATE OR REPLACE VIEW app.v_monthly_summary WITH (security_invoker = true) AS  WITH purchased AS (
         SELECT date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date AS month,
            count(*) AS "仕入数",
            sum(items.cost_amount) AS "仕入金額",
            avg(items.cost_amount)::bigint AS "平均仕入額"
           FROM app.items
          GROUP BY (date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date)
        ), sold AS (
         SELECT date_trunc('month'::text, items.sold_on::timestamp with time zone)::date AS month,
            count(DISTINCT items.lot_seq) FILTER (WHERE NOT (items.is_accessory AND COALESCE(items.sold_price, 0) = 0 AND COALESCE(items.payout_amount, 0) = 0)) AS "販売数",
            sum(items.sold_price) AS "売上",
            sum(items.payout_amount) AS "振込金額",
            sum(items.profit) AS "粗利益",
            avg(items.sold_price)::bigint AS "平均販売額",
            avg(items.sold_on - items.purchased_at)::numeric(10,1) AS "平均回転日数"
           FROM app.items
          WHERE items.sold_on IS NOT NULL
          GROUP BY (date_trunc('month'::text, items.sold_on::timestamp with time zone)::date)
        ), expense AS (
         SELECT date_trunc('month'::text, expenses.incurred_on::timestamp with time zone)::date AS month,
            sum(expenses.amount) AS "経費"
           FROM app.expenses
          GROUP BY (date_trunc('month'::text, expenses.incurred_on::timestamp with time zone)::date)
        )
 SELECT COALESCE(p.month, s.month, e.month) AS month,
    COALESCE(p."仕入数", 0::bigint) AS "仕入数",
    COALESCE(p."仕入金額", 0::numeric) AS "仕入金額",
    COALESCE(p."平均仕入額", 0::bigint) AS "平均仕入額",
    COALESCE(s."販売数", 0::bigint) AS "販売数",
    COALESCE(s."売上", 0::numeric) AS "売上",
    COALESCE(s."振込金額", 0::numeric) AS "振込金額",
    COALESCE(s."粗利益", 0::numeric) AS "粗利益",
    COALESCE(s."平均販売額", 0::bigint) AS "平均販売額",
    s."平均回転日数",
    COALESCE(e."経費", 0::numeric) AS "経費",
    COALESCE(s."粗利益", 0::numeric) - COALESCE(e."経費", 0::numeric) AS "純利益"
   FROM purchased p
     FULL JOIN sold s ON s.month = p.month
     FULL JOIN expense e ON e.month = COALESCE(p.month, s.month)
  ORDER BY (COALESCE(p.month, s.month, e.month)) DESC;
CREATE OR REPLACE VIEW app.v_stock_summary WITH (security_invoker = true) AS  SELECT count(DISTINCT lot_seq) AS "現在庫数",
    sum(cost_amount) AS "仕入金額合計",
    sum(COALESCE(planned_payout, 0::bigint)) AS "売上見込み合計",
    sum(COALESCE(planned_payout, 0::bigint) - cost_amount) AS "見込み利益合計",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) <= 7) AS "高回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 8 AND (CURRENT_DATE - purchased_at) <= 14) AS "中回転",
    count(*) FILTER (WHERE (CURRENT_DATE - purchased_at) >= 15) AS "低回転",
    count(*) FILTER (WHERE status = '作業中'::app.item_status) AS "作業中",
    count(*) FILTER (WHERE status = '仕入済'::app.item_status) AS "入荷待ち"
   FROM app.items
  WHERE status <> ALL (ARRAY['販売済'::app.item_status, '返品処理'::app.item_status, '廃棄'::app.item_status]);
