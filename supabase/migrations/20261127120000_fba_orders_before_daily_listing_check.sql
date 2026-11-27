-- Amazonの倉庫に着いてすぐ売れたFBA商品も「取引中」にする（2026-11-27）。
-- アプリは毎日1時の全出品レポートで「商品登録前→出品中」にしているが、Amazonは倉庫に着いた時点で売り始める。
-- そのため、着いてから1時の確認までに入った注文は、状態が「商品登録前」のまま、または注文時刻が出品登録時刻より前になり、
-- 取引中にならなかった（11/26の2474・2488・2489・2496・2497。売れた通知だけが出ていた）。
-- FBAの注文に限り、FBA納品（取り消していないもの）に入っている「商品登録前」も対象にし、
-- 時刻の確認は「出品登録時刻」と「FBA納品の作成時刻」の早い方を使う。自己発送の条件は変えない。
CREATE OR REPLACE FUNCTION app.record_amazon_sale_page(p_account text, p_lease uuid, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  activation timestamptz;
  item app.items;
  r record;
  channel text;
  label text;
  queued integer:=0;
  item_price text;
begin
  select enabled_at into strict activation from app.amazon_sale_poll
  where account_id=p_account and lease_id=p_lease and lease_until>now() for update;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>200 then
    raise exception 'Invalid orders page';
  end if;
  for r in select * from jsonb_to_recordset(p_rows) as x(order_id text,line_id text,sku text,asin text,product_title text,
     fulfillment text,purchased_at timestamptz,amount integer) loop
    if r.purchased_at is null or r.purchased_at < activation or r.purchased_at > now()
      or coalesce(r.order_id,'') !~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$' or length(coalesce(r.line_id,'')) not between 1 and 80
      or length(coalesce(r.sku,'')) not between 1 and 160 or coalesce(r.asin,'') !~ '^[A-Z0-9]{10}$'
      or coalesce(r.fulfillment,'') not in ('AMAZON','MERCHANT') then continue;end if;
    channel := (case r.fulfillment when 'AMAZON' then 'FBA' else '自己発送' end);
    label := (case p_account when 'amazon-1' then 'Amazon1' else 'Amazon2' end)||'（'||channel||'）';
    select i.* into item from app.items i
    where i.id=(select min(m.id::text)::uuid from app.items m where btrim(m.asin::text)=r.asin
      and (m.sales_channel::text=channel||right(p_account,1) or (p_account='amazon-1' and m.sales_channel::text=channel))
      and app.inventory_sku_matches(m.id,m.sku,r.sku) having count(*)=1);
    if item.id is not null then
      update app.items i set status='取引中',
        seller_trade_key=case when r.fulfillment='MERCHANT' then null else i.seller_trade_key end,
        seller_cancelled_at=case when r.fulfillment='MERCHANT' then null else i.seller_cancelled_at end,
        seller_cancelled_trade_key=case when r.fulfillment='MERCHANT' then null else i.seller_cancelled_trade_key end
      where i.id=item.id
        and (i.status='出品中'
          or (r.fulfillment='AMAZON' and i.status='商品登録前' and exists(
            select 1 from app.fba_inbound_items fi join app.fba_inbound_plans p on p.id=fi.plan_id
            where fi.item_id=i.id and p.stage<>'cancelled')))
        and i.sold_on is null and i.returned_on is null
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
        and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
        and ((r.fulfillment='AMAZON' and i.sales_channel::text in ('FBA','FBA1','FBA2'))
          or (r.fulfillment='MERCHANT' and i.sales_channel::text in ('自己発送','自己発送1','自己発送2')))
        and r.purchased_at >= coalesce(
          case when r.fulfillment='AMAZON' then least(i.product_registered_at,
            (select min(p.created_at) from app.fba_inbound_items fi join app.fba_inbound_plans p on p.id=fi.plan_id
             where fi.item_id=i.id and p.stage<>'cancelled')) else i.product_registered_at end,
          i.purchased_at::timestamp at time zone 'Asia/Tokyo')
        and (i.purchased_at is null or (r.purchased_at at time zone 'Asia/Tokyo')::date >= i.purchased_at);
    end if;
    item_price := case when r.amount>0 then '｜'||to_char(r.amount,'FM999,999,990')||'円' end;
    if app.record_sale_notice(jsonb_build_array(p_account,r.order_id,r.line_id)::text,item.id,
      concat(label,'で売れました｜【',coalesce(app.product_serial(item.sku,item.lot_seq),left(r.sku,45)),'】',
        left(coalesce(item.title,r.product_title,''),100),item_price)) then queued:=queued+1;end if;
  end loop;
  return queued;
end $function$;

revoke all on function app.record_amazon_sale_page(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function app.record_amazon_sale_page(text,uuid,jsonb) to service_role;

-- 取りこぼした11/26の5件を直す（Amazonの注文番号つきの売れた通知があり、Amazonの在庫は0を確認済み）。
-- 変更前の状態は控えに残す。状態が変わっていたら触らない。
create table if not exists app.backup_fba_early_sales_20261127 as
  select id,sku,status,product_registered_at,updated_at,now() as backed_up_at from app.items where false;
alter table app.backup_fba_early_sales_20261127 enable row level security;
revoke all on app.backup_fba_early_sales_20261127 from public,anon,authenticated;
with target as (
  select i.id from app.items i
  where i.sku in ('2474-AALL-20261109-1223','2497-EELL-20261116-1117','2488-EELL-20261113-1263',
                  '2489-EELL-20261112-1040','2496-AALL-20261114-1207')
    and i.sales_channel='FBA2' and i.status in ('出品中','商品登録前') and i.sold_on is null
    and exists(select 1 from app.sale_notices n where n.item_id=i.id and n.source_key like '["amazon-2", %'
               and n.message like 'Amazon2（FBA）で売れました%')
), saved as (
  insert into app.backup_fba_early_sales_20261127(id,sku,status,product_registered_at,updated_at,backed_up_at)
  select i.id,i.sku,i.status,i.product_registered_at,i.updated_at,now() from app.items i join target t on t.id=i.id
  returning id
)
update app.items i set status='取引中' from saved s where i.id=s.id;
