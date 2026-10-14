-- Finance-only lineage; existing SKU, search and routing retain their exact serial.
create or replace function app.financial_product_serial(p_sku text,p_lot_seq integer)
returns text language sql immutable security invoker set search_path='' as $$
 select regexp_replace(lower(app.product_serial(p_sku,p_lot_seq)), '^([0-9]+)[ab]+$', '\1');
$$;
create index if not exists items_financial_family_idx on app.items (app.financial_product_serial(sku,lot_seq));
create or replace view app.v_financial_members with (security_invoker=true) as
select i.id,i.sku,i.lot_seq,i.is_accessory,i.parent_item_id,i.title,i.marketplace,
 i.purchased_at,i.created_at,i.status,i.sold_on,i.sold_price,i.payout_amount,
 i.cost_amount,i.refund_amount,i.inventory_refund_amount,i.shipping_cost,i.other_cost,
 lower(app.product_serial(i.sku,i.lot_seq)) as serial_key,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key,
 (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq)) as is_sale_item
from app.items i;
create or replace view app.v_financial_families with (security_invoker=true) as
with bodies as (
 select distinct on (family_key) family_key,id as origin_item_id,cost_amount as body_cost,purchased_at as origin_purchased_at
 from app.v_financial_members where is_sale_item
 order by family_key,(serial_key=family_key) desc,purchased_at nulls last,created_at,id
), accessories as (
 select family_key,sum(cost_amount)::bigint as accessory_cost
 from app.v_financial_members where not is_sale_item group by family_key
)
select b.family_key,b.origin_item_id,b.origin_purchased_at,
 (b.body_cost+coalesce(a.accessory_cost,0))::bigint as family_cost
from bodies b left join accessories a using(family_key);

-- A zero-value closure with a successor is history; genuine standalone zero-price sales remain sales.
create or replace view app.v_financial_sale_sources with (security_invoker=true) as
select m.* from app.v_financial_members m
where m.is_sale_item and m.sold_on is not null
 and not (m.sold_price is not distinct from 0 and m.payout_amount is not distinct from 0
 and m.refund_amount=0 and m.inventory_refund_amount=0 and m.shipping_cost=0 and m.other_cost=0 and exists (
  select 1 from app.v_financial_members successor
  where successor.is_sale_item and successor.family_key=m.family_key and successor.serial_key<>m.serial_key
   and (m.serial_key=m.family_key or
     (coalesce(successor.purchased_at,successor.created_at::date),successor.created_at,successor.id)>
     (coalesce(m.purchased_at,m.created_at::date),m.created_at,m.id))
 ));
-- Count each actual sale stage; synchronized accessory amounts are not a second sale.
-- Charge the original body and accessory cost once, at the first genuine sale.
create or replace view app.v_financial_sales with (security_invoker=true) as
with events as (
 select s.*,row_number() over(partition by family_key order by sold_on,purchased_at nulls last,created_at,id) as family_sale_order
 from app.v_financial_sale_sources s
), costs as (
 select e.id,coalesce(sum(a.refund_amount+a.inventory_refund_amount),0)::bigint as accessory_refunds,
 coalesce(sum(a.shipping_cost),0)::bigint as accessory_shipping,
 coalesce(sum(a.other_cost),0)::bigint as accessory_other
 from events e left join app.v_financial_members a on not a.is_sale_item
  and a.serial_key=e.serial_key and (a.parent_item_id is null or a.parent_item_id=e.id)
 group by e.id
)
select e.id,e.lot_seq,e.sku,e.is_accessory,e.title,e.marketplace,
 f.origin_purchased_at as purchased_at,e.sold_on,
 case when e.family_sale_order=1 then f.family_cost else 0::bigint end as cost_amount,
 e.sold_price,e.payout_amount,
 (e.refund_amount+e.inventory_refund_amount+c.accessory_refunds)::bigint as refund_amount,
 (e.shipping_cost+c.accessory_shipping)::bigint as shipping_cost,
 (e.other_cost+c.accessory_other)::bigint as other_cost,
 (coalesce(e.payout_amount,0)+e.refund_amount+e.inventory_refund_amount+c.accessory_refunds
  -case when e.family_sale_order=1 then f.family_cost else 0 end
  -e.shipping_cost-c.accessory_shipping-e.other_cost-c.accessory_other)::bigint as profit,
 e.family_key,e.serial_key,f.family_cost,f.origin_item_id
from events e join app.v_financial_families f using(family_key) join costs c on c.id=e.id;
revoke all on app.v_financial_members,app.v_financial_families,app.v_financial_sale_sources,app.v_financial_sales from anon;
grant select on app.v_financial_members,app.v_financial_families,app.v_financial_sale_sources,app.v_financial_sales to authenticated,service_role;
create or replace view app.v_monthly_summary as
 WITH purchased AS (
         SELECT date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date AS month,
            count(*) AS "仕入数",
            sum(items.cost_amount) AS "仕入金額",
            avg(items.cost_amount)::bigint AS "平均仕入額"
           FROM app.items
          GROUP BY (date_trunc('month'::text, items.purchased_at::timestamp with time zone)::date)
        ), sold AS (
         SELECT date_trunc('month'::text, items.sold_on::timestamp with time zone)::date AS month,
            count(DISTINCT items.family_key) AS "販売数",
            sum(items.sold_price) AS "売上",
            sum(items.payout_amount) AS "振込金額",
            sum(items.profit) AS "粗利益",
            avg(items.sold_price)::bigint AS "平均販売額",
            avg(items.sold_on - items.purchased_at)::numeric(10,1) AS "平均回転日数"
           FROM app.v_financial_sales items
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

create or replace view app.v_inventory_display as
 WITH financial_totals AS MATERIALIZED (select family_key,sum(profit)::numeric as profit from app.v_financial_sales group by family_key), totals AS MATERIALIZED (
         SELECT app.product_serial(i.sku, i.lot_seq) AS serial_key,
            sum(i.refund_amount) AS refunds,
            sum(i.inventory_refund_amount) AS inventory_refunds,
            sum(i.shipping_cost) AS shipping,
            sum(i.other_cost) AS other_cost
           FROM app.items i
          GROUP BY (app.product_serial(i.sku, i.lot_seq))
        )
 SELECT inventory.id,
    inventory.sku,
    inventory.lot_seq,
    inventory.is_accessory,
    inventory.status,
    inventory.condition,
    inventory.title,
    inventory.asin,
    inventory.model_no,
    inventory.maker,
    inventory.genre,
    inventory.turnover,
    inventory.purchased_at,
    inventory.cost_amount,
    inventory.marketplace,
    inventory.marketplace_url,
    inventory.card_name,
    inventory.purchaser_name,
    inventory.deliverer_name,
    inventory.work_stream,
    inventory.deliverer_id,
    inventory.purchaser_id,
    inventory.tracking_no,
    inventory.planned_price,
    inventory.planned_payout,
    inventory.sales_channel,
    inventory.product_registered,
    inventory.inspected,
    inventory.photo_uploaded,
    inventory.packed_on,
    inventory.shipped_on,
    inventory.listed_on,
    inventory.sold_on,
    inventory.sold_price,
    inventory.payout_amount,
    inventory.amazon_returned_on,
    inventory.refund_amount,
    inventory.profit,
    inventory.days_to_sell,
    inventory.days_in_stock,
    (inventory.planned_payout+coalesce(financial_totals.profit,-family.family_cost,-inventory.product_cost))::bigint AS expected_profit,
    inventory.accessories,
    inventory.memo,
    inventory.updated_at,
    inventory.product_row_count,
    coalesce(family.family_cost,inventory.product_cost)::bigint AS product_cost,
    inventory.sale_row_count,
    inventory.product_sale_conflict,
    inventory.product_sold_on,
    inventory.product_sold_price,
    inventory.product_payout_amount,
    raw.product_id,
    product.product_no,
    COALESCE(NULLIF(btrim(product.image_url), ''::text), NULLIF(btrim(asin_product.image_url), ''::text)) AS amazon_image_url,
    raw.amazon_refund_amount,
    raw.non_amazon_refund_amount,
    latest.body AS latest_comment,
        CASE WHEN NOT inventory.product_sale_conflict AND inventory.product_sold_on IS NOT NULL
          THEN financial_totals.profit
          ELSE NULL::numeric END AS product_profit,
    raw.inventory_refund_amount
   FROM app.v_inventory_items inventory
     JOIN app.items raw ON raw.id = inventory.id
     LEFT JOIN app.v_financial_families family ON family.family_key=app.financial_product_serial(raw.sku,raw.lot_seq)
     LEFT JOIN financial_totals ON financial_totals.family_key=family.family_key
     LEFT JOIN app.products product ON product.id = raw.product_id
     LEFT JOIN app.products asin_product ON asin_product.asin = raw.asin
     LEFT JOIN totals ON totals.serial_key = app.product_serial(raw.sku, raw.lot_seq)
     LEFT JOIN LATERAL ( SELECT item_comments.body
           FROM app.item_comments
          WHERE item_comments.item_id = inventory.id
          ORDER BY item_comments.created_at DESC, item_comments.id DESC
         LIMIT 1) latest ON true;

create or replace view app.v_stock_summary as
with current_items as (
 select distinct on (app.financial_product_serial(i.sku,i.lot_seq)) i.*,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key
 from app.items i where not i.is_accessory and i.status not in ('販売済','返品処理') and i.sold_on is null
 order by app.financial_product_serial(i.sku,i.lot_seq),i.purchased_at desc nulls last,i.created_at desc,i.id
)
select count(*) as "現在庫数",coalesce(sum(f.family_cost),0)::numeric as "仕入金額合計",
 coalesce(sum(coalesce(i.planned_payout,0)),0)::numeric as "売上見込み合計",
 coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,-f.family_cost)),0)::numeric as "見込み利益合計",
 count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
 count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
 count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
 count(*) filter(where i.status='作業中') as "作業中",
 count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using(family_key)
left join (select family_key,sum(profit) as profit from app.v_financial_sales group by family_key) realized using(family_key);
notify pgrst,'reload schema';


-- Use the same sale events and original purchaser in staff profit reports.
create or replace function app.monthly_gross_profit_by_purchaser(p_purchaser_id uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare current_id uuid:=app.current_staff_id(); current_user_role text:=app.current_role(); result jsonb;
begin
 if auth.uid() is null or current_id is null or p_month is null or extract(day from p_month)<>1 then
  raise exception '対象月またはログイン情報が不正です' using errcode='22023';
 end if;
 if current_user_role='admin' then
  if p_purchaser_id is null or not exists(select 1 from app.staff where id=p_purchaser_id and is_active and role in ('admin','purchaser')) then
   raise exception '仕入担当者を選択してください' using errcode='22023';
  end if;
 elsif current_user_role='purchaser' then
  if p_purchaser_id is distinct from current_id then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 elsif current_user_role='deliverer' then
  if p_purchaser_id is not null then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 else raise exception '閲覧する権限がありません' using errcode='42501'; end if;

 with products as (
  select s.serial_key,s.sku,s.sold_on,owner.name as purchaser_name,s.profit as gross_profit
  from app.v_financial_sales s
  join app.items event_item on event_item.id=s.id
  join app.items origin on origin.id=s.origin_item_id
  left join app.staff owner on owner.id=origin.purchaser_id
  where s.sold_on>=p_month and s.sold_on<p_month+interval '1 month'
    and ((current_user_role='admin' and origin.purchaser_id=p_purchaser_id)
      or (current_user_role='purchaser' and origin.purchaser_id=current_id)
      or (current_user_role='deliverer' and event_item.deliverer_id=current_id))
 )
 select jsonb_build_object(
  'rows',coalesce(jsonb_agg(jsonb_build_object('sku',sku,'sold_on',sold_on,'purchaser_name',purchaser_name,'gross_profit',gross_profit) order by sold_on,sku),'[]'::jsonb),
  'total',coalesce(sum(gross_profit),0)
 ) into result from products;
 return result;
end $$;
revoke all on function app.monthly_gross_profit_by_purchaser(uuid,date) from public,anon,authenticated;
grant execute on function app.monthly_gross_profit_by_purchaser(uuid,date) to authenticated;
