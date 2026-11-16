-- Use the catalogue's shipping category for the two requested assignees.
-- Keep the existing assignee for items outside these categories.
do $migration$
declare
  definition text:=pg_get_functiondef('app.import_amazon_fba_customer_returns(text,uuid,text,jsonb)'::regprocedure);
  anchor text;
begin
  anchor:='  source_channel text;';
  if strpos(definition,anchor)=0 then raise exception 'FBA return declaration missing'; end if;
  definition:=replace(definition,anchor,anchor||E'\n  return_deliverer uuid;\n  deliverer_code text;');

  anchor:='when source_item.deliverer_id is null or source_item.purchaser_id is null';
  if strpos(definition,anchor)=0 then raise exception 'FBA return owner check missing'; end if;
  definition:=replace(definition,anchor,'when source_item.purchaser_id is null');

  anchor:=$old$    if review_note is null then
      select count(*),(array_agg(i.id))[1] into manual_count,existing_id from app.items i$old$;
  if strpos(definition,anchor)=0 then raise exception 'FBA return item lookup missing'; end if;
  definition:=replace(definition,anchor,$new$    if review_note is null then
      select case coalesce(p.shipping_category::text,case
        when source_item.description_template='ブルーレイレコーダー' then 'ブ'
        when source_item.description_template='小物' then '小'
        when source_item.description_template is null and source_item.work_stream='ブルーレイ' then 'ブ'
        when source_item.description_template is null and source_item.work_stream in ('その他','付属品') then '小'
      end) when 'ブ' then 'II' when '小' then 'DD' end into deliverer_code
      from (values (1)) seed(n)
      left join app.products p on p.id=source_item.product_id
        or (source_item.product_id is null and nullif(source_item.asin,'')=p.asin);
      return_deliverer:=source_item.deliverer_id;
      if deliverer_code is not null then
        select s.id into return_deliverer from app.staff s where s.code=deliverer_code and s.is_active;
      end if;
      if return_deliverer is null then review_note:='返品の納品担当者を確認できません'; end if;
    end if;
$new$||anchor);

  anchor:='i.marketplace=''Amazon返品'' and i.amazon_returned_on=shipment.returned_on';
  if strpos(definition,anchor)=0 then raise exception 'FBA manual return date check missing'; end if;
  definition:=replace(definition,anchor,
    'i.marketplace=''Amazon返品'' and coalesce(i.amazon_returned_on,i.purchased_at)=shipment.returned_on');

  anchor:=$old$      elsif manual_count=1 then
        linked:=linked+1;$old$;
  if strpos(definition,anchor)=0 then raise exception 'FBA manual return association missing'; end if;
  definition:=replace(definition,anchor,$new$      elsif manual_count=1 then
        update app.items set return_reason=shipment.reason
        where id=existing_id and nullif(btrim(return_reason),'') is null and nullif(btrim(shipment.reason),'') is not null;
        linked:=linked+1;$new$);

  anchor:=$old$          insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,work_stream,title,cost_amount,
            marketplace,marketplace_item_id,marketplace_url,product_id,asin,condition,
            planned_price,planned_payout,sales_channel,amazon_returned_on,return_reason)
          values(source_item.sku,source_item.lot_seq,source_item.purchaser_id,source_item.deliverer_id,source_item.work_stream,
            source_item.title,0,'Amazon返品',source_item.marketplace_item_id,source_item.marketplace_url,
            source_item.product_id,source_item.asin,source_item.condition,
            source_item.planned_price,source_item.planned_payout,source_item.sales_channel,shipment.returned_on,nullif(shipment.reason,''))
$old$;
  if strpos(definition,anchor)=0 then raise exception 'FBA return registration fields missing'; end if;
  definition:=replace(definition,anchor,$new$          insert into app.items(lot_seq,purchaser_id,deliverer_id,work_stream,title,cost_amount,
            marketplace,marketplace_item_id,marketplace_url,product_id,asin,condition,
            planned_price,planned_payout,sales_channel,purchased_at,return_reason)
          values(source_item.lot_seq,source_item.purchaser_id,return_deliverer,source_item.work_stream,
            source_item.title,0,'Amazon返品',source_item.marketplace_item_id,source_item.marketplace_url,
            source_item.product_id,source_item.asin,source_item.condition,
            source_item.planned_price,source_item.planned_payout,source_item.sales_channel,shipment.returned_on,nullif(shipment.reason,''))
$new$);
  execute definition;
end
$migration$;

notify pgrst, 'reload schema';
