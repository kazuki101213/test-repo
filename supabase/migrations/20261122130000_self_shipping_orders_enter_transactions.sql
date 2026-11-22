-- Confirmed Amazon self-shipping (MERCHANT) orders enter transactions, like FBA orders.
-- Since 2026-11-18 only FBA orders moved to 取引中, so a self-shipping order produced a sale
-- notice but no shipping task (capture_shipping_request runs when status becomes 取引中).
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
    -- A confirmed order changes inventory state before financial settlement (FBA and self-shipping).
    -- Never infer a sale from zero stock, or reopen final/returned/problem items.
    if item.id is not null then
      update app.items i set status='取引中'
      where i.id=item.id and i.status='出品中'
        and i.sold_on is null and i.returned_on is null
        and not coalesce(i.malfunction_reported and i.malfunction_resolved_at is null,false)
        and (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq))
        and ((r.fulfillment='AMAZON' and i.sales_channel::text in ('FBA','FBA1','FBA2'))
          or (r.fulfillment='MERCHANT' and i.sales_channel::text in ('自己発送','自己発送1','自己発送2')))
        and r.purchased_at >= coalesce(i.product_registered_at,
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
