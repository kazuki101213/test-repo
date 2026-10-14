create or replace view app.v_financial_sale_sources with (security_invoker=true) as
with members as materialized (select * from app.v_financial_members)
select m.* from members m
where m.is_sale_item and m.sold_on is not null
 and not (m.sold_price is not distinct from 0 and m.payout_amount is not distinct from 0
 and m.refund_amount=0 and m.inventory_refund_amount=0 and m.shipping_cost=0 and m.other_cost=0 and exists (
  select 1 from members successor
  where successor.is_sale_item and successor.family_key=m.family_key and successor.serial_key<>m.serial_key
   and (m.serial_key=m.family_key or
     (coalesce(successor.purchased_at,successor.created_at::date),successor.created_at,successor.id)>
     (coalesce(m.purchased_at,m.created_at::date),m.created_at,m.id))
 ));

-- Defer the family cost while the latest return stage is unsold.
-- Allocate once to the latest genuine sale after the current stage sells.
create or replace view app.v_financial_sales with (security_invoker=true) as
with latest_stages as (
 select distinct on (m.family_key) m.family_key,m.serial_key,m.sold_on,m.status,
  i.returned_on,i.amazon_returned_on
 from app.v_financial_members m join app.items i on i.id=m.id where m.is_sale_item
 order by m.family_key,m.created_at desc,length(m.serial_key) desc,m.purchased_at desc nulls last,m.id
), events as (
 select s.*,row_number() over(partition by family_key order by sold_on desc,created_at desc,length(serial_key) desc,purchased_at desc nulls last,id desc) as family_sale_order
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
 case when e.family_sale_order=1 and terminal.serial_key=e.serial_key and terminal.sold_on is not null and terminal.status<>'返品処理' and (terminal.returned_on is null or terminal.returned_on<=e.sold_on) and (terminal.amazon_returned_on is null or terminal.amazon_returned_on<=e.sold_on) then f.family_cost else 0::bigint end as cost_amount,
 e.sold_price,e.payout_amount,
 (e.refund_amount+e.inventory_refund_amount+c.accessory_refunds)::bigint as refund_amount,
 (e.shipping_cost+c.accessory_shipping)::bigint as shipping_cost,
 (e.other_cost+c.accessory_other)::bigint as other_cost,
 (coalesce(e.payout_amount,0)+e.refund_amount+e.inventory_refund_amount+c.accessory_refunds
  -case when e.family_sale_order=1 and terminal.serial_key=e.serial_key and terminal.sold_on is not null and terminal.status<>'返品処理' and (terminal.returned_on is null or terminal.returned_on<=e.sold_on) and (terminal.amazon_returned_on is null or terminal.amazon_returned_on<=e.sold_on) then f.family_cost else 0 end
  -e.shipping_cost-c.accessory_shipping-e.other_cost-c.accessory_other)::bigint as profit,
 e.family_key,e.serial_key,f.family_cost,f.origin_item_id
from events e join app.v_financial_families f using(family_key) join costs c on c.id=e.id join latest_stages terminal using(family_key);

create or replace view app.v_inventory_display as
 WITH financial_totals AS MATERIALIZED (select family_key,sum(profit)::numeric as profit,sum(cost_amount)::numeric as allocated_cost from app.v_financial_sales group by family_key)
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
    (inventory.planned_payout+coalesce(financial_totals.profit,0)-coalesce(family.family_cost,inventory.product_cost)+coalesce(financial_totals.allocated_cost,0))::bigint AS expected_profit,
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
 coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,0)-f.family_cost+coalesce(realized.allocated_cost,0)),0)::numeric as "見込み利益合計",
 count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
 count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
 count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
 count(*) filter(where i.status='作業中') as "作業中",
 count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using(family_key)
left join (select family_key,sum(profit) as profit,sum(cost_amount) as allocated_cost from app.v_financial_sales group by family_key) realized using(family_key);

-- Charge each exact serial's completed work separately; C and B work is half price.
create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception '請求書へのアクセス権がありません' using errcode='42501';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 with invoice_items as (
  select distinct on(lower(app.product_serial(sku,lot_seq))) id,sku,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,
   app.product_serial(sku,lot_seq) as serial_key,
   app.is_standalone_accessory_serial(sku,lot_seq) as standalone,
   (lower(app.product_serial(sku,lot_seq)) ~ '^[0-9]+[ab]*b$' or marketplace::text='動作品Amazon返品') as half_return
  from app.items where deliverer_id=p_staff and packed_on is not null
    and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq))
  order by lower(app.product_serial(sku,lot_seq)),packed_on,id
 ), selected as (
  select *,case when standalone or half_return then floor(p.unit_price/2.0)::bigint else p.unit_price::bigint end as price
  from invoice_items where packed_on>=p_month and packed_on<p_month+interval '1 month'
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'item_id',id,'sku',sku,'serial',serial_key,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
  'description',case when standalone then '付属品単体販売' when half_return then '動作品Amazon返品対応'
   when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
   when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
  'title',title,'quantity',1,'unit_price',price,'amount',price
 ) order by purchased_at nulls last,lot_seq,serial_key,id),'[]'::jsonb),coalesce(sum(price),0)
 into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;
notify pgrst,'reload schema';
