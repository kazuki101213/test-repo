create or replace function app.mercari_shipping_size(p_method text,p_size text) returns text
language sql immutable set search_path='' as $$
 select case
  when p_method='ゆうゆうメルカリ便' and p_size in ('60','80','100') then 'ゆうパック60〜100'
  when p_method='ゆうゆうメルカリ便' and p_size in ('120','140','160','170') then 'ゆうパック120〜170'
  when p_method='らくらくメルカリ便' and p_size in ('60','80','100','120','160') then '宅急便60〜160'
  when p_method='らくらくメルカリ便' and p_size in ('140','180','200') then '宅急便180〜200'
  else p_size
 end;
$$;

create or replace function app.mercari_shipping_settings(p_settings jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when nullif(p_settings->>'size','') is not null
 then jsonb_set(p_settings,'{size}',to_jsonb(app.mercari_shipping_size(p_settings->>'shippingMethod',p_settings->>'size')))
 else p_settings end;
$$;

create or replace function app.mercari_shipping_code_note(p_size text,p_dropoff text) returns text
language sql immutable set search_path='' as $$
 select case
  when p_size in ('ゆうパケットポスト','ゆうパケットポストmini') then 'メルカリの取引画面で専用資材のコードを読み取り、郵便ポストへ投函してください。'
  when p_size='宅急便180〜200' and p_dropoff='セブンイレブン' then '宅急便180〜200はセブンイレブンで発送できません。発送場所を確認してください。'
 end;
$$;

revoke all on function app.mercari_shipping_size(text,text),app.mercari_shipping_settings(jsonb),app.mercari_shipping_code_note(text,text) from public,anon;
-- seller_operation_context is security invoker and calls the pure settings helpers.
grant execute on function app.mercari_shipping_size(text,text),app.mercari_shipping_settings(jsonb) to authenticated,service_role;
grant execute on function app.mercari_shipping_code_note(text,text) to service_role;

-- Existing item-level choices take precedence for Mercari. Keep the physical
-- catalog size carrier-neutral for Yahoo and other channels.
create or replace function app.mercari_item_shipping_defaults(p_item_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select app.mercari_shipping_settings(
  jsonb_strip_nulls(jsonb_build_object(
   'shippingMethod',coalesce(current_code.payload->>'shippingMethod',listing.payload->>'shippingMethod',
    case when staff.name ~ '吉光|コエル' then 'ゆうゆうメルカリ便' else 'らくらくメルカリ便' end),
   'dropoff',coalesce(current_code.payload->>'dropoff',listing.payload->>'dropoff',
    case when staff.name ~ '吉光|コエル' then 'ローソン' when staff.name ~ '石川' then 'ヤマト営業所'
     when staff.name ~ '久保田|土井|新川' then 'セブンイレブン' end),
   'category',coalesce(current_code.payload->'category',listing.payload->'category')))
  || coalesce(pref.shipping,'{}'::jsonb)
  || jsonb_strip_nulls(jsonb_build_object('size',coalesce(
   nullif(pref.shipping->>'size',''),
   nullif(current_code.payload->>'size',''),
   app.line_fixed_shipping_size(i.id),
   nullif(listing.payload->>'size',''),
   app.line_learned_shipping_size(i.id)))))
 from app.items i
 join app.seller_listings l on l.item_id=i.id and l.active and l.channel=i.sales_channel
 left join app.staff staff on staff.id=i.deliverer_id
 left join app.delivery_line_preferences pref on pref.item_id=i.id
 left join lateral (
  select o.payload from app.seller_operations o where o.item_id=i.id and o.channel=l.channel and o.account_id=l.account_id
   and o.kind='listing' and o.status='succeeded' and o.result->>'external_id'=l.external_id order by o.created_at desc limit 1
 ) listing on true
 left join lateral (
  select o.payload from app.seller_operations o where o.item_id=i.id and o.channel=l.channel and o.account_id=l.account_id
   and o.kind in ('shipping_code','register_package') and o.status='succeeded' and o.payload->>'trade_key'=l.trade_key
   order by o.created_at desc limit 1
 ) current_code on true
 where i.id=p_item_id and i.sales_channel='メルカリ';
$$;
revoke all on function app.mercari_item_shipping_defaults(uuid) from public,anon;
grant execute on function app.mercari_item_shipping_defaults(uuid) to authenticated,service_role;

do $migration$
declare
 definition text := pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 old_start text := $old$'shipping_defaults',($old$;
 old_end text := $old$   ) s where l.item_id=i.id and l.active
 ),$old$;
 new_start text := $new$'shipping_defaults',case when i.sales_channel='メルカリ' then app.mercari_item_shipping_defaults(i.id) else ($new$;
begin
 if strpos(definition,new_start)>0 then return;end if;
 if strpos(definition,old_start)=0 or strpos(definition,old_end)=0 then raise exception 'Seller shipping settings query changed';end if;
 execute replace(replace(definition,old_start,new_start),old_end,replace(old_end,' ),',' ) end,'));
end $migration$;

create or replace function app.seller_shipping_validation_error(
 p_item_id uuid,p_channel text,p_kind text,p_payload jsonb
) returns text
language plpgsql stable set search_path=pg_catalog,app as $$
declare
 catalog_size text := app.line_fixed_shipping_size(p_item_id);
 shipment_size text := coalesce(p_payload->>'size','');
 method text := p_payload->>'shippingMethod';
 dropoff text := coalesce(p_payload->>'dropoff','');
begin
 if p_channel='メルカリ' then
  shipment_size:=app.mercari_shipping_size(method,shipment_size);
  if (case method
    when 'らくらくメルカリ便' then shipment_size in ('ネコポス','宅急便コンパクト','宅急便60〜160','宅急便180〜200')
      and dropoff in ('セブンイレブン','ヤマト営業所')
    when 'ゆうゆうメルカリ便' then shipment_size in ('ゆうパケット','ゆうパケットポストmini','ゆうパケットポスト','ゆうパケットプラス','ゆうパック60〜100','ゆうパック120〜170')
      and dropoff in ('ローソン','郵便局')
    else false end) is not true then
   return '配送方法に対応する配送サイズと発送場所を選択してください';
  end if;
  if p_kind='register_package' and p_payload->>'size'='ゆうパケットポストmini' then return null;end if;
  if p_kind='register_package' then return 'メルカリの取引画面で専用資材のコードを読み取ってください';end if;
  if app.mercari_shipping_code_note(shipment_size,dropoff) is not null then return app.mercari_shipping_code_note(shipment_size,dropoff);end if;
  if p_payload ? 'automatic_line' and catalog_size is null and not exists (
   select 1 from app.delivery_line_preferences pref where pref.item_id=p_item_id
   and app.mercari_shipping_size(method,pref.shipping->>'size')=shipment_size
  ) then
   return '商品リストの配送サイズが未設定です。サイズを保存してからコードを発行してください';
  end if;
  return null;
 end if;

 if catalog_size is not null then
  if shipment_size<>catalog_size then return '商品リストと配送サイズが一致しません。設定を確認してください';end if;
  return null;
 end if;
 if p_payload ? 'automatic_line' then return '商品リストの配送サイズが未設定です。サイズを保存してからコードを発行してください';end if;
 if (case method
   when 'おてがる配送（ヤマト運輸）' then p_channel='ヤフオク' and shipment_size in ('100','140','宅急便コンパクト') and dropoff in ('セブンイレブン','ヤマト営業所')
   when 'おてがる配送（日本郵便）' then p_channel='ヤフオク' and shipment_size in ('100','140','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') and dropoff in ('ローソン','郵便局')
   else false end) is not true or ((p_kind='register_package')<>(shipment_size='ゆうパケットポストmini')) then
  return '配送方法に対応する配送サイズと発送場所を選択してください';
 end if;
 return null;
end;
$$;

revoke all on function app.seller_shipping_validation_error(uuid,text,text,jsonb) from public,anon,authenticated;

-- Convert preferences when read, including old entries, and persist canonical
-- values on new saves. Leave historical requests and shipping locations intact.
do $migration$
declare
 signature text;
 definition text;
 old_size_list text := $list$'200','ネコポス','宅急便コンパクト','ゆうパケットプラス'$list$;
 ranges text := $list$'宅急便60〜160','宅急便180〜200','ゆうパック60〜100','ゆうパック120〜170'$list$;
 anchor text;
begin
 foreach signature in array array[
  'app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb)',
  'app.extension_prepare_line_shipping(text[])',
  'app.queue_packed_shipping_code(uuid)',
  'app.remember_line_shipping_size(uuid)'
 ] loop
  if to_regprocedure(signature) is null and signature='app.queue_packed_shipping_code(uuid)' then continue;end if;
  definition:=pg_get_functiondef(to_regprocedure(signature));
  if strpos(definition,ranges)>0 then continue;end if;
  if strpos(definition,old_size_list)=0 then raise exception 'Shipping options changed: %',signature;end if;
  definition:=replace(definition,old_size_list,old_size_list||','||ranges);
  if signature like 'app.save_line_shipping_preferences%' then
   anchor:=' foreach photo in array';
   if strpos(definition,anchor)=0 then raise exception 'Shipping preference save changed';end if;
   definition:=replace(definition,anchor,$save$ if i.sales_channel='メルカリ' then
  p_shipping:=app.mercari_shipping_settings(p_shipping);
 end if;
 foreach photo in array$save$);
   definition:=replace(definition,'''ゆうパケットポストmini'',''ゆうパケット''','''ゆうパケットポストmini'',''ゆうパケットポスト'',''ゆうパケット''');
  elsif signature like 'app.extension_prepare_line_shipping%' then
   anchor:=$old$  if app.line_fixed_shipping_size(i.id) is not null then settings:=settings||jsonb_build_object('size',app.line_fixed_shipping_size(i.id));end if;$old$;
   if strpos(definition,anchor)=0 then raise exception 'LINE shipping defaults changed';end if;
   definition:=replace(definition,anchor,$new$  if i.sales_channel='メルカリ' then
   settings:=coalesce(app.seller_operation_context(i.id)->'shipping_defaults','{}'::jsonb);
  elsif app.line_fixed_shipping_size(i.id) is not null then
   settings:=settings||jsonb_build_object('size',app.line_fixed_shipping_size(i.id));
  end if;$new$);
  elsif signature like 'app.remember_line_shipping_size%' then
   anchor:=' if actual_size not in';
   if strpos(definition,anchor)=0 then raise exception 'Shipping history capture changed';end if;
   definition:=replace(definition,anchor,$remember$ actual_size:=case actual_size
  when '宅急便60〜160' then '100' when 'ゆうパック60〜100' then '100'
  when '宅急便180〜200' then '140' when 'ゆうパック120〜170' then '140' else actual_size end;
 if actual_size not in$remember$);
   definition:=replace(definition,','||ranges,'');
   definition:=replace(definition,'''ゆうパケットポストmini'',''ゆうパケット''','''ゆうパケットポストmini'',''ゆうパケットポスト'',''ゆうパケット''');
  end if;
  execute definition;
 end loop;
end $migration$;

alter table app.products drop constraint if exists products_shipping_size_check;
alter table app.products add constraint products_shipping_size_check
 check(shipping_size is null or shipping_size in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケットポスト','ゆうパケット'));
alter table app.delivery_line_size_history drop constraint if exists delivery_line_size_history_size_check;
alter table app.delivery_line_size_history add constraint delivery_line_size_history_size_check
 check(size in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケットポスト','ゆうパケット'));

CREATE OR REPLACE FUNCTION app.line_shipping_media(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select case
  when required.needs_code and code.id is null then null
  else jsonb_build_object(
   'itemId',i.id,
   'serial',app.product_serial(i.sku,i.lot_seq),
   'sku',i.sku,
   'supplierUrl',i.marketplace_url,
   'automatic',true,
   'photoPaths',case when front.id is not null and model.id is not null
    then jsonb_build_array(front.storage_path,model.storage_path)
    else coalesce((select jsonb_agg(photo.storage_path order by photo.created_at,photo.id)
     from (select p.id,p.storage_path,p.created_at from app.item_photos p
      where p.item_id=i.id and coalesce(p.photo_kind,'product')='product'
       and p.storage_path ~* '\.(jpe?g|png)$'
      order by p.created_at,p.id limit 2) photo),'[]'::jsonb) end,
   'codeOperationId',code.id,
   'withoutBarcode',case when shipping.code_note is not null then 'carrier_instructions' when not required.needs_code then 'size_unset' end,
   'shipping',case when i.sales_channel='メルカリ' and listing.item_id is not null then jsonb_strip_nulls(jsonb_build_object(
    'method',coalesce(code.payload->>'shippingMethod',shipping.settings->>'shippingMethod'),
    'size',app.mercari_shipping_size(coalesce(code.payload->>'shippingMethod',shipping.settings->>'shippingMethod'),
      coalesce(code.payload->>'size',shipping.settings->>'size')),
    'dropoff',coalesce(code.payload->>'dropoff',shipping.settings->>'dropoff'),
    'note',shipping.code_note,
    'tradeUrl',case when shipping.code_note is not null and listing.external_id ~ '^m[0-9]{8,14}$'
     then 'https://jp.mercari.com/transaction/'||listing.external_id end)) end
  )
 end
 from app.delivery_line_outbox o
 join app.delivery_shipping_tasks t on t.id=o.task_id
 join app.items i on i.id=t.item_id
 left join app.delivery_line_preferences pref on pref.item_id=i.id
 left join app.item_photos front on front.id=pref.overview_photo_id
  and front.item_id=i.id and coalesce(front.photo_kind,'product')='product'
  and front.storage_path ~* '\.(jpe?g|png)$'
 left join app.item_photos model on model.id=pref.model_photo_id
  and model.item_id=i.id and coalesce(model.photo_kind,'product')='product'
  and model.storage_path ~* '\.(jpe?g|png)$'
 left join app.seller_listings listing on listing.item_id=i.id and listing.active
  and listing.trade_key=o.trade_key
 left join lateral (
  select cfg.settings,app.mercari_shipping_code_note(cfg.settings->>'size',cfg.settings->>'dropoff') as code_note
  from (select app.mercari_item_shipping_defaults(i.id) as settings) cfg
  where i.sales_channel='メルカリ' and listing.item_id is not null
 ) shipping on true
 left join lateral (
  select shipping.code_note is null and (app.line_fixed_shipping_size(i.id) is not null
    or (i.sales_channel='メルカリ' and nullif(pref.shipping->>'size','') is not null)) as needs_code
 ) required on true
 left join lateral (
  select op.id,op.payload from app.seller_operations op
  where required.needs_code and listing.item_id is not null
   and op.item_id=i.id and op.account_id=listing.account_id and op.channel=listing.channel
   and op.kind in ('shipping_code','register_package') and op.status='succeeded'
   and op.payload->>'trade_key'=o.trade_key
   and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null
   and (i.sales_channel<>'メルカリ' or (
    op.payload->>'shippingMethod' is not distinct from shipping.settings->>'shippingMethod'
    and op.payload->>'dropoff' is not distinct from shipping.settings->>'dropoff'
    and not (op.payload->>'shippingMethod'='らくらくメルカリ便' and op.payload->>'size'='140')
    and app.mercari_shipping_size(op.payload->>'shippingMethod',op.payload->>'size') is not distinct from shipping.settings->>'size'))
  order by op.created_at desc limit 1
 ) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id);
$function$;

notify pgrst,'reload schema';
