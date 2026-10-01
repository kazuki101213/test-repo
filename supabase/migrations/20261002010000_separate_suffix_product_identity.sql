-- SKU serials such as 1977, 1977A and 1977AA identify distinct physical products.
-- Keep lot_seq as the supplier-row FK; use the complete SKU serial for product grouping.
create or replace function app.product_serial(p_sku text, p_lot_seq integer default null)
returns text language sql immutable parallel safe set search_path = '' as $$
  select coalesce(upper((regexp_match(p_sku, '^([0-9]+[a-z]*)[-_]'))[1]), p_lot_seq::text)
$$;

create or replace view app.v_product_groups with (security_invoker = true) as
with grouped as (
  select min(lot_seq) as lot_seq, app.product_serial(sku, lot_seq) as serial_key,
    count(*)::integer as product_row_count, sum(cost_amount)::bigint as product_cost,
    count(*) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))::integer as sale_row_count,
    count(distinct (sold_on,sold_price,payout_amount)) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as signatures,
    bool_or(sold_on is not null and sold_price is null and not is_accessory) as missing_price,
    min(sold_on) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_date,
    max(sold_price) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_price,
    max(payout_amount) filter(where sold_on is not null and not (is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as sale_payout
  from app.items group by app.product_serial(sku, lot_seq)
)
select lot_seq,product_row_count,product_cost,sale_row_count,
  (signatures > 1 or coalesce(missing_price,false)) as product_sale_conflict,
  case when signatures=1 and not coalesce(missing_price,false) then sale_date end as product_sold_on,
  case when signatures=1 and not coalesce(missing_price,false) then sale_price end as product_sold_price,
  case when signatures=1 and not coalesce(missing_price,false) then sale_payout end as product_payout_amount,
  serial_key
from grouped;
grant select on app.v_product_groups to authenticated,service_role;

create or replace view app.v_inventory_items with (security_invoker = true) as
select i.*,g.product_row_count,g.product_cost,g.sale_row_count,g.product_sale_conflict,
  g.product_sold_on,g.product_sold_price,g.product_payout_amount
from app.v_items i join app.v_product_groups g
  on g.serial_key=app.product_serial(i.sku,i.lot_seq);
grant select on app.v_inventory_items to authenticated;

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*, raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds - inventory.product_cost
      - totals.shipping - totals.other_cost end as product_profit
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join lateral (select body from app.item_comments where item_id=inventory.id order by created_at desc,id desc limit 1) latest on true
left join lateral (
  select sum(refund_amount) as refunds,sum(shipping_cost) as shipping,sum(other_cost) as other_cost
  from app.items where app.product_serial(sku,lot_seq)=app.product_serial(raw.sku,raw.lot_seq)
) totals on true;
grant select on app.v_inventory_display to authenticated;

create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path='' as $$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then return new; end if;
  serial_key := app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>new.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    raise exception '同じ商品番号の商品に販売記録があります。売上を重複登録できません。';
  end if;
  return new;
end; $$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;

create or replace function app.apply_amazon_sale(
  p_account text,p_transaction text,p_sku text,p_asin text,p_sold_on date,p_price bigint,p_payout bigint,p_actor uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_lot integer; target_count integer; serial_key text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status in ('RELEASED','DEFERRED_RELEASED');
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  select id,lot_seq into target_id,target_lot from app.items where sku=p_sku;
  serial_key:=app.product_serial(p_sku,null);
  if target_id is null and serial_key is not null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then return jsonb_build_object('status','review','reason','同じ商品番号の本体行を1件に特定できません。'); end if;
    select lot_seq into target_lot from app.items where id=target_id;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・商品番号が在庫一覧にありません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if inventory.status in ('返品処理','Amazon返品','廃棄') or inventory.amazon_returned_on is not null or inventory.returned_on is not null or (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','返品・廃棄、または仕入日より前の販売のため確認が必要です。'); end if;
  if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>inventory.id and i.sold_on is not null and not(i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)) then
    if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>inventory.id and i.sold_on is not null and not(i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and (i.sold_on is distinct from p_sold_on or i.sold_price is distinct from p_price or i.payout_amount is distinct from p_payout)) then return jsonb_build_object('status','review','reason','同じ商品番号に異なる販売記録があります。自動上書きしません。'); end if;
    return jsonb_build_object('status','unchanged','reason','同じ商品番号に同じ販売内容を登録済みです。重複記入しません。');
  end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif (inventory.sold_on is not null and inventory.sold_on<>p_sold_on) or (inventory.sold_price is not null and inventory.sold_price<>p_price) or (inventory.payout_amount is not null and inventory.payout_amount<>p_payout) then return jsonb_build_object('status','review','reason','既存の販売記録と異なります。自動上書きしません。'); end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を反映しました。');
end; $$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;

create or replace view app.v_stock_summary with (security_invoker = true) as
select count(distinct app.product_serial(sku,lot_seq)) as "現在庫数",
  sum(cost_amount) as "仕入金額合計",sum(coalesce(planned_payout,0)) as "売上見込み合計",
  sum(coalesce(planned_payout,0)-cost_amount) as "見込み利益合計",
  count(*) filter(where current_date-purchased_at<=7) as "高回転",
  count(*) filter(where current_date-purchased_at between 8 and 14) as "中回転",
  count(*) filter(where current_date-purchased_at>=15) as "低回転",
  count(*) filter(where status='作業中'::app.item_status) as "作業中",
  count(*) filter(where status='仕入済'::app.item_status) as "入荷待ち"
from app.items where status not in ('販売済'::app.item_status,'返品処理'::app.item_status,'廃棄'::app.item_status);

create or replace view app.v_monthly_summary with (security_invoker = true) as
with purchased as (
 select date_trunc('month',purchased_at::timestamptz)::date as month,count(*) as "仕入数",sum(cost_amount) as "仕入金額",avg(cost_amount)::bigint as "平均仕入額"
 from app.items group by 1
), sold as (
 select date_trunc('month',sold_on::timestamptz)::date as month,
  count(distinct app.product_serial(sku,lot_seq)) filter(where not(is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0)) as "販売数",
  sum(sold_price) as "売上",sum(payout_amount) as "振込金額",sum(profit) as "粗利益",avg(sold_price)::bigint as "平均販売額",
  avg(sold_on-purchased_at)::numeric(10,1) as "平均回転日数"
 from app.items where sold_on is not null group by 1
), expense as (
 select date_trunc('month',incurred_on::timestamptz)::date as month,sum(amount) as "経費" from app.expenses group by 1
)
select coalesce(p.month,s.month,e.month) as month,coalesce(p."仕入数",0::bigint) as "仕入数",
 coalesce(p."仕入金額",0::numeric) as "仕入金額",coalesce(p."平均仕入額",0::bigint) as "平均仕入額",
 coalesce(s."販売数",0::bigint) as "販売数",coalesce(s."売上",0::numeric) as "売上",coalesce(s."振込金額",0::numeric) as "振込金額",
 coalesce(s."粗利益",0::numeric) as "粗利益",coalesce(s."平均販売額",0::bigint) as "平均販売額",s."平均回転日数",
 coalesce(e."経費",0::numeric) as "経費",coalesce(s."粗利益",0::numeric)-coalesce(e."経費",0::numeric) as "純利益"
from purchased p full join sold s on s.month=p.month full join expense e on e.month=coalesce(p.month,s.month)
order by coalesce(p.month,s.month,e.month) desc;

create or replace function app.packed_product_summary(p_staff uuid,p_month date default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false)
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 if p_month is not null and extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 with bodies as (
  select distinct on(app.product_serial(sku,lot_seq)) id,lot_seq,purchased_at,packed_on,title,sku
  from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
  order by app.product_serial(sku,lot_seq),packed_on,id
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'lot_seq',lot_seq,'purchased_at',purchased_at,'packed_on',packed_on,'title',title,'sku',sku) order by packed_on desc,lot_seq desc),'[]'::jsonb)
 into result from bodies where p_month is null or (packed_on>=p_month and packed_on<p_month+interval '1 month');
 return result;
end $$;
revoke all on function app.packed_product_summary(uuid,date) from public,anon,authenticated;
grant execute on function app.packed_product_summary(uuid,date) to authenticated;

create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then raise exception '請求書へのアクセス権がありません' using errcode='42501'; end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 with bodies as (
  select distinct on(app.product_serial(sku,lot_seq)) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,sku
  from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
  order by app.product_serial(sku,lot_seq),packed_on,id
 ), selected as (select * from bodies where packed_on>=p_month and packed_on<p_month+interval '1 month')
 select coalesce(jsonb_agg(jsonb_build_object('item_id',id,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
  'description',case when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
   when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
  'title',title,'quantity',1,'unit_price',p.unit_price,'amount',p.unit_price) order by purchased_at nulls last,lot_seq),'[]'::jsonb),count(*)*p.unit_price
 into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

create or replace view app.v_amazon_unmatched_app_sales with (security_invoker=true) as
with amazon_serials as (
 select distinct app.product_serial(canonical_sku,null) as serial_key
 from app.v_amazon_order_reconciliation
 where order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and item_price is not null
), sold_products as (
 select min(lot_seq) as lot_seq,app.product_serial(sku,lot_seq) as serial_key,min(sold_on) as app_sold_on,max(sold_price) as app_sold_price,
  min(sku) as example_sku,string_agg(distinct sales_channel::text,', ') as sales_channels,count(*) as app_row_count
 from app.items where sold_on is not null and sales_channel::text in ('FBA','自己発送') and is_accessory=false
 group by app.product_serial(sku,lot_seq)
)
select s.lot_seq,s.app_sold_on,s.app_sold_price,s.example_sku,s.sales_channels,s.app_row_count
from sold_products s where not exists(select 1 from amazon_serials a where a.serial_key=s.serial_key);
grant select on app.v_amazon_unmatched_app_sales to authenticated;

notify pgrst,'reload schema';
