-- Replace the Yahoo listing defaults with the staff assignment and the
-- registered product's shipping rule. Sale history is used only for small items.
create function app.yahoo_listing_shipping(p_item_id uuid, p_category text default null)
returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare
 item app.items;
 product app.products;
 staff_code text;
 carrier text;
 dispatch_origin text;
 dropoff text;
 category text;
 previous jsonb;
 shipment_size text;
 shipment_weight text;
 source text := 'review';
begin
 select * into item from app.items where id=p_item_id and sales_channel='ヤフオク';
 if item.id is null then return null; end if;
 if auth.uid() is null or not coalesce(app.is_admin() or item.deliverer_id=app.current_staff_id(),false) then
  return null;
 end if;

 select s.code into staff_code from app.staff s where s.id=item.deliverer_id and s.is_active;
 select s.carrier,s.origin,s.dropoff into carrier,dispatch_origin,dropoff
 from (values
  ('DD','おてがる配送（ヤマト運輸）','愛媛県','セブンイレブン'),
  ('II','おてがる配送（ヤマト運輸）','愛媛県','セブンイレブン'),
  ('HH','おてがる配送（ヤマト運輸）','千葉県','セブンイレブン'),
  ('LL','おてがる配送（ヤマト運輸）','新潟県','セブンイレブン'),
  ('EE','おてがる配送（ヤマト運輸）','山梨県','ヤマト営業所'),
  ('KK','おてがる配送（日本郵便）','埼玉県','ローソン'),
  ('MM','おてがる配送（日本郵便）','千葉県','ローソン')
 ) s(code,carrier,origin,dropoff) where s.code=staff_code;

 select p.* into product from app.products p
 where p.id=item.product_id or (item.product_id is null and nullif(item.asin,'')=p.asin)
 order by (p.id=item.product_id) desc limit 1;
 category:=case product.shipping_category
  when 'ブ' then 'ブルーレイレコーダー'
  when 'モ' then case when coalesce(item.description_template::text,p_category)='テレビ' then 'テレビ' else 'モニター' end
  when '小' then '小物'
  else coalesce(item.description_template,nullif(p_category,''))
 end;

 if category in ('ブルーレイレコーダー','モニター','テレビ') then
  shipment_size:=case category when 'ブルーレイレコーダー' then '120' else '140' end;
  shipment_weight:='5';
  source:='fixed';
 elsif category='小物' or category is null then
  -- Pick the latest sale of this product, even if its shipping details are
  -- unavailable. Match operations to the actual listing or transaction.
  select coalesce(listed.payload,'{}'::jsonb)||coalesce(shipped.payload,'{}'::jsonb) into previous
  from (
   select i.id
   from app.items i
   where i.id<>item.id and i.sold_on is not null and i.is_accessory=item.is_accessory
    and ((item.product_id is not null and i.product_id=item.product_id)
      or (coalesce(nullif(item.asin,''),nullif(product.asin,'')) is not null
        and i.asin=coalesce(nullif(item.asin,''),nullif(product.asin,''))))
   order by i.sold_on desc,i.updated_at desc,i.id
   limit 1
  ) sold
  left join lateral (
   select l.* from app.seller_listings l
   where l.item_id=sold.id and (l.verified_sale is not null or l.observed_status='販売済')
   order by (l.verified_sale is not null) desc,l.observed_at desc nulls last,l.id limit 1
  ) listing on true
  left join lateral (
   select o.payload from app.seller_operations o
   where o.item_id=sold.id and o.kind='listing' and o.status='succeeded'
    and o.channel=listing.channel and o.account_id=listing.account_id and o.result->>'external_id'=listing.external_id
   order by o.created_at desc,o.id limit 1
  ) listed on true
  left join lateral (
   select o.payload from app.seller_operations o
   where o.item_id=sold.id and o.kind in ('shipping_code','register_package') and o.status='succeeded'
    and o.channel=listing.channel and o.account_id=listing.account_id and o.payload->>'trade_key'=listing.trade_key
   order by o.created_at desc,o.id limit 1
  ) shipped on true;

  shipment_size:=previous->>'size';
  if (case carrier
   when 'おてがる配送（ヤマト運輸）' then shipment_size in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト')
   when 'おてがる配送（日本郵便）' then shipment_size in ('60','80','100','120','140','160','170','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット')
   else false end) is true then
   if shipment_size ~ '^[0-9]+$' then
    shipment_weight:=previous->>'weightKg';
    if shipment_weight not in ('2','5','10','15','20','25')
     and not (shipment_size in ('180','200') and shipment_weight='30') then
     shipment_weight:=null;
    end if;
   end if;
   source:='sale';
  else
   shipment_size:=null;
  end if;
 end if;

 return jsonb_strip_nulls(jsonb_build_object('category',category,'shippingMethod',coalesce(carrier,''),
  'origin',coalesce(dispatch_origin,''),'dropoff',coalesce(dropoff,''),'size',shipment_size,
  'weightKg',shipment_weight,'source',source));
end;
$$;

revoke all on function app.yahoo_listing_shipping(uuid,text) from public,anon;
grant execute on function app.yahoo_listing_shipping(uuid,text) to authenticated;

create function app.yahoo_listing_shipping_error(p_item_id uuid,p_payload jsonb)
returns text
language plpgsql stable set search_path=pg_catalog,app as $$
declare
 rule jsonb:=app.yahoo_listing_shipping(p_item_id,p_payload->>'category');
 carrier text:=rule->>'shippingMethod';
 shipment_size text:=p_payload->>'size';
 shipment_weight text:=p_payload->>'weightKg';
begin
 if p_payload->'yahoo_shipping_rule' is distinct from '1'::jsonb then return '画面を更新して配送設定を取得してください。'; end if;
 if nullif(carrier,'') is null then return '担当者のヤフオク配送設定を確認してください。'; end if;
 if coalesce(rule->>'category','') not in ('ブルーレイレコーダー','モニター','テレビ','小物')
  or p_payload->>'category' is distinct from rule->>'category'
  or p_payload->>'shippingMethod' is distinct from carrier
  or p_payload->>'origin' is distinct from rule->>'origin'
  or p_payload->>'dropoff' is distinct from rule->>'dropoff'
  or (rule ? 'size' and shipment_size is distinct from rule->>'size')
  or (rule ? 'weightKg' and shipment_weight is distinct from rule->>'weightKg') then
  return '配送設定が更新されています。出品画面を開き直してください。';
 end if;
 if (case carrier
  when 'おてがる配送（ヤマト運輸）' then shipment_size in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト')
  when 'おてがる配送（日本郵便）' then shipment_size in ('60','80','100','120','140','160','170','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット')
  else false end) is not true
  or (shipment_size ~ '^[0-9]+$' and (shipment_weight in ('2','5','10','15','20','25')
    or (shipment_size in ('180','200') and shipment_weight='30')) is not true) then
  return '梱包後の配送サイズと重さを確認してください。';
 end if;
 return null;
end;
$$;

revoke all on function app.yahoo_listing_shipping_error(uuid,jsonb) from public,anon,authenticated;

-- The active Yahoo listing is the source for the size used after the sale.
-- Historical listings and other marketplaces still use the product list.
create or replace function app.line_fixed_shipping_size(p_item_id uuid)
returns text
language sql stable set search_path='' as $$
 select coalesce(
  (
   select o.payload->>'size'
   from app.seller_listings l
   join app.seller_operations o on o.item_id=l.item_id and o.channel=l.channel
    and o.account_id=l.account_id and o.result->>'external_id'=l.external_id
   where l.item_id=p_item_id and l.active and l.channel='ヤフオク'
    and o.kind='listing' and o.status='succeeded' and o.payload->'yahoo_shipping_rule'='1'::jsonb
    and o.payload->>'category' in ('ブルーレイレコーダー','モニター','テレビ')
   order by o.created_at desc limit 1
  ),(
   select p.shipping_size
   from app.items i
   join app.products p on p.id=i.product_id or (i.product_id is null and nullif(i.asin,'') is not null and p.asin=i.asin)
   where i.id=p_item_id and (not i.is_accessory or p.shipping_category='小')
   order by (p.id=i.product_id) desc limit 1
  )
 );
$$;

do $migration$
declare
 current_definition text;
 anchor text;
begin
 current_definition:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 anchor:=' ''shipping_defaults'',case when';
 if strpos(current_definition,anchor)=0 then raise exception 'seller context shipping anchor missing'; end if;
 execute replace(current_definition,anchor,
  ' ''yahoo_listing_shipping'',case when i.status=''商品登録前'' then app.yahoo_listing_shipping(i.id) end,'|| E'\n'||anchor);

 current_definition:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 anchor:='  IF p_kind = ''listing'' THEN';
 if strpos(current_definition,anchor)=0 then raise exception 'seller queue listing anchor missing'; end if;
 execute replace(current_definition,anchor,anchor||E'\n'||$body$
    IF i.sales_channel = 'ヤフオク' THEN
      DECLARE
        validation_error text := app.yahoo_listing_shipping_error(i.id,p_payload);
      BEGIN
        IF validation_error IS NOT NULL THEN
          RAISE EXCEPTION USING message=validation_error,errcode='22023';
        END IF;
      END;
    END IF;$body$);

 current_definition:=pg_get_functiondef('app.extension_claim_seller_operation(uuid,text)'::regprocedure);
 anchor:='        and (o.kind <> ''listing'' or app.listing_photos_approved(i.id))';
 if strpos(current_definition,anchor)=0 then raise exception 'seller claim photo approval anchor missing'; end if;
 execute replace(current_definition,anchor,anchor|| E'\n'||
  '        and (o.kind <> ''listing'' or o.channel <> ''ヤフオク'' or o.payload->''yahoo_shipping_rule'' = ''1''::jsonb)');
end;
$migration$;
