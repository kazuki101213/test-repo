begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select 998982,s.id,s.id,current_date,'app handoff fixture',1000,'メルカリ','メルカリ' from app.staff s join app.profiles p on p.staff_id=s.id where s.role='admin' and s.is_active limit 1;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select 998983,s.id,s.id,current_date,'app handoff fixture',1000,'ヤフオク','ヤフオク' from app.staff s join app.profiles p on p.staff_id=s.id where s.role='admin' and s.is_active limit 1;
update app.items set status='取引中',seller_trade_key=case when lot_seq=998982 then 'm99998200001:'||current_date::text else 'a99998300001' end where lot_seq in (998982,998983);
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_url,trade_key)
select id,sales_channel,case when lot_seq=998982 then 'mercari-2' else 'auctions-1' end,
case when lot_seq=998982 then 'm99998200001' else 'a99998300001' end,
case when lot_seq=998982 then 'https://jp.mercari.com/item/m99998200001' else 'https://auctions.yahoo.co.jp/jp/auction/a99998300001' end,
case when lot_seq=998982 then 'https://jp.mercari.com/transaction/m99998200001' else 'https://contact.auctions.yahoo.co.jp/seller/top?aid=a99998300001' end,seller_trade_key
from app.items where lot_seq in (998982,998983);
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result,finished_at)
select gen_random_uuid(),i.id,i.purchaser_id,'shipping_code',i.sales_channel,l.account_id,i.status,i.updated_at,jsonb_build_object('trade_key',i.seller_trade_key),'succeeded','{"qr_code":"fixture"}',clock_timestamp()
from app.items i join app.seller_listings l on l.item_id=i.id where i.lot_seq in (998982,998983);
select set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.items i on p.staff_id=i.purchaser_id where i.lot_seq=998982 limit 1),true);
set local role authenticated;
do $test$
declare i app.items;proof jsonb;op jsonb;accounts text[]:=array['mercari-2','auctions-1'];
begin
 for i in select * from app.items where lot_seq in (998982,998983) loop
  if exists(select 1 from jsonb_array_elements(app.extension_daily_shipping_candidates(accounts)) r where r->>'item_id'=i.id::text) then raise exception 'Code alone triggered shipment';end if;
  proof:=jsonb_build_object('source','delivery_handoff','accepted',true,'observed_at',clock_timestamp());
  if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Unrecorded handoff claimed';end if;
  if app.mercari_shipping_handoff(i.id,i.seller_trade_key,true)<>'confirmed' then raise exception 'Handoff not saved';end if;
  if not exists(select 1 from jsonb_array_elements(app.extension_daily_shipping_candidates(accounts)) r where r->>'item_id'=i.id::text and r->>'handoff_confirmed'='true') then raise exception 'Confirmed recent code missing';end if;
  if app.extension_claim_daily_shipping_notice(i.id,'wrong',i.updated_at,proof) is not null then raise exception 'Wrong trade claimed';end if;
  if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at-interval '1 second',proof) is not null then raise exception 'Stale item claimed';end if;
  if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof||'{"source":"mercari_shipping_status"}') is not null then raise exception 'Old trigger accepted';end if;
  op:=app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof);
  if op is null then raise exception 'Confirmed handoff not claimed';end if;
  if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Duplicate notice claimed';end if;
 end loop;
end $test$;
reset role;
rollback;
