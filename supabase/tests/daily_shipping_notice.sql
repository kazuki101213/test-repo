begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
values(998982,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'automatic shipping fixture',1000,'メルカリ','メルカリ');
update app.items set status='取引中',seller_trade_key='m99998200001:'||(current_date-2)::text where lot_seq=998982;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_url,trade_key)
select id,'メルカリ','mercari-2','m99998200001','https://jp.mercari.com/item/m99998200001','https://jp.mercari.com/transaction/m99998200001',seller_trade_key from app.items where lot_seq=998982;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result,finished_at)
select gen_random_uuid(),id,purchaser_id,'shipping_code','メルカリ','mercari-2',status,updated_at,jsonb_build_object('trade_key',seller_trade_key),'succeeded','{"qr_code":"fixture"}',now()-interval '25 hours' from app.items where lot_seq=998982;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 begin perform app.extension_daily_shipping_candidates(array['mercari-2']);raise exception 'Deliverer called batch';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare i app.items;proof jsonb;op jsonb;id uuid;
begin
 select * into i from app.items where lot_seq=998982;
 if not exists(select 1 from jsonb_array_elements(app.extension_daily_shipping_candidates(array['mercari-2'])) r where r->>'item_id'=i.id::text) then raise exception 'Eligible shipment missing';end if;
 if exists(select 1 from jsonb_array_elements(app.extension_daily_shipping_candidates(array['mercari-1'])) r where r->>'item_id'=i.id::text) then raise exception 'Other account returned';end if;
 proof:=jsonb_build_object('carrier','yamato','tracking_number','999999999999','source','https://toi.kuronekoyamato.co.jp/cgi-bin/tneko','accepted',true,'accepted_at',clock_timestamp()-interval '1 hour','observed_at',clock_timestamp());
 if app.extension_claim_daily_shipping_notice(i.id,'wrong-trade',i.updated_at,proof) is not null then raise exception 'Wrong trade claimed';end if;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof||'{"accepted":false}') is not null then raise exception 'Code only claimed';end if;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof||jsonb_build_object('accepted_at',clock_timestamp()-interval '30 days')) is not null then raise exception 'Old shipment claimed';end if;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof||'{"source":"https://example.com"}') is not null then raise exception 'Untrusted source claimed';end if;
 op:=app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof);
 if op is null then raise exception 'Accepted shipment not claimed';end if;id:=(op->>'id')::uuid;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Double claim';end if;
 perform app.extension_finish_seller_operation(id,'succeeded','{"notified":true,"automatic":true}');
 if exists(select 1 from jsonb_array_elements(app.extension_daily_shipping_candidates(array['mercari-2'])) r where r->>'item_id'=i.id::text) then raise exception 'Notified shipment queried again';end if;
 if exists(select 1 from app.delivery_shipping_tasks where item_id=i.id and resolved_at is null) then raise exception 'Request remained';end if;
 if (select shipped_on from app.items where app.items.id=i.id) is not null then raise exception 'Shipping date inferred';end if;
end $$;

reset role;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select fixture.lot,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date-5,'shipment without waybill',1000,'メルカリ','メルカリ'
from (values (998983),(998984),(998985)) fixture(lot);
update app.items set status='取引中',
 seller_trade_key='m999'||lot_seq||':'||(current_date-2)::text where lot_seq between 998983 and 998985;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_url,trade_key)
select id,'メルカリ','mercari-2',split_part(seller_trade_key,':',1),
 'https://jp.mercari.com/item/'||split_part(seller_trade_key,':',1),
 'https://jp.mercari.com/transaction/'||split_part(seller_trade_key,':',1),seller_trade_key
from app.items where lot_seq between 998983 and 998985;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result,finished_at)
select gen_random_uuid(),id,purchaser_id,'shipping_code','メルカリ','mercari-2',status,updated_at,
 jsonb_build_object('trade_key',seller_trade_key),'succeeded','{"qr_code":"fixture"}',
 now()-case when lot_seq=998984 then interval '25 hours' else interval '2 hours' end
from app.items where lot_seq in (998984,998985);
select set_config('test.shipping_item',id::text,true),
       set_config('test.shipping_trade',seller_trade_key,true)
from app.items where lot_seq=998983;

set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$
begin
 begin
  perform app.mercari_shipping_handoff(current_setting('test.shipping_item')::uuid,current_setting('test.shipping_trade'),true);
  raise exception 'Other user can record a handoff';
 exception when insufficient_privilege then null;end;
end $$;

set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$
declare i app.items;
begin
 select * into strict i from app.items where lot_seq=998983;
 if app.mercari_shipping_handoff(i.id,i.seller_trade_key)<>'pending' then raise exception 'Unexpected handoff';end if;
 if app.mercari_shipping_handoff(i.id,i.seller_trade_key,true)<>'confirmed' then raise exception 'Assigned deliverer could not record handoff';end if;
 if app.mercari_shipping_handoff(i.id,i.seller_trade_key,true)<>'confirmed' then raise exception 'Handoff not idempotent';end if;
 select * into strict i from app.items where lot_seq=998985;
 perform app.mercari_shipping_handoff(i.id,i.seller_trade_key,true);
end $$;

set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare i app.items;proof jsonb;op jsonb;
begin
 proof:=jsonb_build_object('source','delivery_handoff','accepted',true,'observed_at',clock_timestamp());
 select * into strict i from app.items where lot_seq=998983;
 if not exists(
  select 1 from jsonb_array_elements(app.extension_daily_shipping_candidates(array['mercari-2'])) r
  where r->>'item_id'=i.id::text and r->>'handoff_confirmed'='true'
 ) then raise exception 'Confirmed handoff without a code is missing';end if;
 op:=app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof);
 if op is null then raise exception 'Confirmed handoff without a visible waybill could not be claimed';end if;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Double handoff claim';end if;
 perform app.extension_finish_seller_operation((op->>'id')::uuid,'succeeded','{"notified":true,"automatic":true}');
 if app.mercari_shipping_handoff(i.id,i.seller_trade_key)<>'notified' then raise exception 'Send outcome not displayed';end if;

 select * into strict i from app.items where lot_seq=998985;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Recent code did not wait 24 hours';end if;

 select * into strict i from app.items where lot_seq=998984;
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Unconfirmed handoff was claimed';end if;
 proof:=proof||'{"source":"mercari_shipping_status","status":"発送してください"}';
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is not null then raise exception 'Generic dispatch instruction was accepted as proof';end if;
 proof:=proof||'{"status":"荷物受付"}';
 if app.extension_claim_daily_shipping_notice(i.id,i.seller_trade_key,i.updated_at,proof) is null then raise exception 'Native acceptance without waybill was rejected';end if;
end $$;
rollback;

