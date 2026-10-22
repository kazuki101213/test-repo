begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
values(998982,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'automatic shipping fixture',1000,'メルカリ','メルカリ');
update app.items set status='取引中',seller_trade_key='m99998200001:'||(current_date-2)::text where lot_seq=998982;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_url,trade_key)
select id,'メルカリ','mercari-2','m99998200001','https://jp.mercari.com/item/m99998200001','https://jp.mercari.com/transaction/m99998200001',seller_trade_key from app.items where lot_seq=998982;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result)
select gen_random_uuid(),id,purchaser_id,'shipping_code','メルカリ','mercari-2',status,updated_at,jsonb_build_object('trade_key',seller_trade_key),'succeeded','{"qr_code":"fixture"}' from app.items where lot_seq=998982;
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
rollback;

