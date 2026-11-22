begin;
do $$
declare
  fixture_id uuid;
  listing_id uuid;
  key text;
  notice_id uuid;
  lease uuid;
  amazon_row jsonb;
  purchase_time timestamptz;
begin
  if has_function_privilege('authenticated','app.record_sale_notice(text,uuid,text)','execute')
    or has_function_privilege('anon','app.record_amazon_sale_page(text,uuid,jsonb)','execute') then
    raise exception 'Sale notification is callable by a browser client';
  end if;
  insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
    select 989692,p.id,d.id,current_date,'Sale notification fixture',1000,'ヤフオク','メルカリ'
    from app.staff p,app.staff d where p.code='AA' and d.code='DD' returning id into strict fixture_id;
  insert into app.seller_listings(item_id, channel, account_id, external_id, url)
    values(fixture_id,'メルカリ','mercari-2','m989692','https://jp.mercari.com/item/m989692')
    returning id into listing_id;
  update app.seller_listings set observed_status='出品中',observed_at=now() where id=listing_id;
  update app.seller_listings set observed_status='支払い待ち',trade_key='m989692',observed_at=now() where id=listing_id;
  if exists(select 1 from app.sale_notices n where n.item_id=fixture_id) then
    raise exception 'An unpaid flea-market order notified staff';
  end if;
  update app.seller_listings set observed_status='取引中',observed_at=now() where id=listing_id;
  update app.seller_listings set observed_status='販売済',observed_at=now() where id=listing_id;
  key:=jsonb_build_array('mercari-2','m989692','m989692')::text;
  select id into strict notice_id from app.sale_notices where source_key=key;
  if app.record_sale_notice(key,fixture_id,'duplicate') then raise exception 'Duplicate notice accepted';end if;
  if not exists(select 1 from app.admin_push_events where source_id=notice_id)
    or exists(select 1 from app.admin_push_events e join app.staff s on s.id=e.staff_id
              where e.source_id=notice_id and (s.role<>'admin' or not s.is_active)) then
    raise exception 'Sale notification recipients are incorrect';
  end if;

  select enabled_at into strict purchase_time from app.amazon_sale_poll where account_id='amazon-2';
  lease:=(app.claim_amazon_sale_poll('amazon-2')->>'lease')::uuid;
  amazon_row:=jsonb_build_array(jsonb_build_object('order_id','123-1234567-1234567','line_id','test-line',
    'sku','fixture','asin','B000000001','product_title','Fixture','fulfillment','AMAZON','purchased_at',purchase_time));
  if app.record_amazon_sale_page('amazon-2',lease,amazon_row)<>1
    or app.record_amazon_sale_page('amazon-2',lease,amazon_row)<>0 then
    raise exception 'Amazon repeated poll did not deduplicate';
  end if;

  -- A confirmed self-shipping order enters transactions and creates the shipping task.
  insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,asin)
    select 989693,p.id,d.id,(purchase_time at time zone 'Asia/Tokyo')::date,'Self shipping fixture',1000,'ヤフオク','自己発送2','B000000002'
    from app.staff p,app.staff d where p.code='AA' and d.code='DD' returning id into strict fixture_id;
  update app.items set status='出品中',product_registered_at=purchase_time-interval '1 minute' where id=fixture_id;
  if (select status from app.items where id=fixture_id)<>'出品中' then
    raise exception 'Self shipping fixture could not be listed';
  end if;
  amazon_row:=jsonb_build_array(jsonb_build_object('order_id','123-1234567-7654321','line_id','self-line',
    'sku',(select sku from app.items where id=fixture_id),'asin','B000000002','product_title','Self','fulfillment','MERCHANT',
    'purchased_at',purchase_time));
  if app.record_amazon_sale_page('amazon-2',lease,amazon_row)<>1 then
    raise exception 'Self shipping order was not notified';
  end if;
  if (select status from app.items where id=fixture_id)<>'取引中'
    or not exists(select 1 from app.delivery_shipping_tasks where item_id=fixture_id and resolved_at is null) then
    raise exception 'Self shipping order did not create a shipping task';
  end if;
end $$;
rollback;
