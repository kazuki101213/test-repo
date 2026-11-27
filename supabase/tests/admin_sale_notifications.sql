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
  fixture_plan uuid;
  n integer;
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
  update app.items set status='出品中',product_registered_at=purchase_time-interval '1 minute',
    seller_cancelled_at=purchase_time-interval '2 days',seller_cancelled_trade_key='m989693:2026-01-01T00:00' where id=fixture_id;
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
  if (select seller_cancelled_at is not null or seller_cancelled_trade_key is not null from app.items where id=fixture_id) then
    raise exception 'An old flea-market cancellation still blocks the self shipping LINE request';
  end if;

  -- FBA: Amazonの倉庫に着いてすぐ（毎日1時の出品確認より前に）売れた商品も取引中にする。
  for n in 1..3 loop
    insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,asin)
      select 989693+n,p.id,d.id,(purchase_time at time zone 'Asia/Tokyo')::date,'Early FBA sale fixture',1000,'ヤフオク','FBA2','B00000001'||n
      from app.staff p,app.staff d where p.code='AA' and d.code='DD' returning id into strict fixture_id;
    insert into app.fba_inbound_plans(account,staff_id,name,created_by,stage,created_at)
      select 'FBA2',deliverer_id,'Early FBA sale fixture '||n,'11111111-1111-1111-1111-111111111111',
        case when n=2 then 'cancelled' else 'ready' end,purchase_time-interval '1 day'
      from app.items where id=fixture_id returning id into strict fixture_plan;
    insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel)
      select fixture_plan,id,sku,asin,title,'非常に良い','FBA2' from app.items where id=fixture_id;
    -- 1・2：まだ1時の確認前（商品登録前）。3：1時の確認で出品中になったが、注文はそれより前。
    update app.items set status=case when n=3 then '出品中'::app.item_status else '商品登録前'::app.item_status end,
      product_registered_at=case when n=3 then purchase_time+interval '1 hour' end where id=fixture_id;
    amazon_row:=jsonb_build_array(jsonb_build_object('order_id','123-1234567-765432'||n,'line_id','early-line-'||n,
      'sku',(select sku from app.items where id=fixture_id),'asin','B00000001'||n,'product_title','Early','fulfillment','AMAZON',
      'purchased_at',purchase_time));
    if app.record_amazon_sale_page('amazon-2',lease,amazon_row)<>1 then
      raise exception 'Early FBA order % was not notified',n;
    end if;
    if (select status from app.items where id=fixture_id)<>(case when n=2 then '商品登録前' else '取引中' end)::app.item_status then
      raise exception 'Early FBA order % has the wrong inventory state: %',n,(select status from app.items where id=fixture_id);
    end if;
  end loop;
end $$;
rollback;
