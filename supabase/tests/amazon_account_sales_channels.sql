-- Disposable fixtures: never call Amazon or commit a listing/sale in production.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select 997800+n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'Amazon account channel fixture',1000,'ヤフオク',channel::app.sales_channel,'fixture',now()
from (values(1,'FBA1'),(2,'FBA2'),(3,'自己発送1'),(4,'自己発送2')) x(n,channel);
insert into app.item_photos(item_id,storage_path) select id,'test/amazon-channel-'||lot_seq||'.jpg' from app.items where lot_seq between 997801 and 997804;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at) select id,'fixture',1,now() from app.items where lot_seq between 997801 and 997804;
update app.items set asin='B000TEST01',planned_price=1000,condition='非常に良い' where lot_seq between 997801 and 997804;
insert into app.amazon_listing_submissions(request_id,item_id,requested_by,sku,asin,sales_channel,account_id,seller_id,price,item_condition,description,work_completed_on,state,verified_at,note)
select gen_random_uuid(),i.id,(select user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),i.sku,i.asin,i.sales_channel,case when i.sales_channel::text in ('FBA2','自己発送2') then 'amazon-2' else 'amazon-1' end,case when i.sales_channel::text in ('FBA2','自己発送2') then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end,i.planned_price,i.condition::text,coalesce(i.description,''),current_date-2,'verified',clock_timestamp(),'test-first' from app.items i where lot_seq between 997801 and 997804;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$
declare i record; family app.sales_channel; expected text;
begin
 for i in select id,lot_seq,sales_channel,status from app.items where lot_seq between 997801 and 997804 order by lot_seq loop
  family:=app.sales_channel_family(i.sales_channel);
  if family::text is distinct from (case when i.lot_seq<=997802 then 'FBA' else '自己発送' end) then raise exception 'Wrong fulfillment family'; end if;
  expected:=case when i.lot_seq in (997801,997803) then '0488eda5964421b790fc7dade17b3cbdeea0ced17af746e1f58da2e8199929fb'
   else 'aa469f79b88e99c9cce7a392cd506259919bc673e727044662747cca96304957' end;
  if app.amazon_channel_account_key(i.sales_channel) is distinct from expected then raise exception 'Wrong seller mapping'; end if;
  if family='FBA' then
   insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind) values(i.id,'test/fba-packing-'||i.lot_seq,app.current_staff_id(),'packing');
  end if;
  perform app.perform_dated_inventory_action(i.id,'listing_complete',i.status,current_date-2,(select request_id from app.amazon_listing_submissions where item_id=i.id and note='test-first'));
  if not exists(select 1 from app.items where id=i.id and status='出品中' and packed_on=current_date-2 and sales_channel=i.sales_channel) then raise exception 'Account-specific listing completion failed'; end if;
  if family='自己発送' then
   insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind) values(i.id,'test/self-packing-'||i.lot_seq,app.current_staff_id(),'packing');
  end if;
 end loop;
 if app.sales_channel_family('メルカリ')<>'メルカリ' or app.sales_channel_family('FBA')<>'FBA' or app.sales_channel_family('自己発送')<>'自己発送' then raise exception 'Legacy channel changed'; end if;
end $$;
reset role;
-- An identical SKU from the other seller must never update this item's money.
do $$
declare i record; correct_key text; wrong_key text; actor uuid; result jsonb;
begin
 select p.user_id into actor from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA';
 for i in select id,sku,sales_channel from app.items where lot_seq between 997801 and 997804 loop
  correct_key:=app.amazon_channel_account_key(i.sales_channel);
  wrong_key:=app.amazon_channel_account_key(case when i.sales_channel::text in ('FBA1','自己発送1') then 'FBA2'::app.sales_channel else 'FBA1'::app.sales_channel end);
  insert into app.amazon_payment_transactions(account_key,marketplace_id,transaction_id,posted_at,transaction_type,status,item_breakdowns,fetched_at)
  select key,'A1VC38T7YXB528','channel-sale-'||i.id,now(),'Shipment','RELEASED',jsonb_build_array(jsonb_build_object('sku',i.sku,'currency','JPY','quantity',1,'amount',1700)),now()
  from unnest(array[correct_key,wrong_key]) key;
  result:=app.apply_amazon_sale(wrong_key,'channel-sale-'||i.id,i.sku,null,current_date,2000,1700,actor);
  if result->>'status'<>'review' or exists(select 1 from app.items where id=i.id and sold_on is not null) then raise exception 'Wrong seller updated a sale'; end if;
  result:=app.apply_amazon_sale(correct_key,'channel-sale-'||i.id,i.sku,null,current_date,2000,1700,actor);
  if result->>'status'<>'applied' or not exists(select 1 from app.items where id=i.id and sold_price=2000 and payout_amount=1700) then raise exception 'Correct seller failed: %',result; end if;
 end loop;
end $$;
do $$declare options text[];begin
 select reloptions into options from pg_class where oid='app.v_deliverer_workload'::regclass;
 if not ('security_invoker=true'=any(options))
 or not ('security_barrier=true'=any(options)) then raise exception 'View security options changed'; end if;
 if has_function_privilege('anon','app.sales_channel_family(app.sales_channel)','execute') then raise exception 'Anonymous helper grant'; end if;
 if position('amazon_channel_account_key' in pg_get_functiondef('app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid)'::regprocedure))=0
 or position('amazon_channel_account_key' in pg_get_functiondef('app.apply_amazon_refund(text,text,text,uuid)'::regprocedure))=0 then raise exception 'Payment account guard missing'; end if;
end $$;
rollback;
