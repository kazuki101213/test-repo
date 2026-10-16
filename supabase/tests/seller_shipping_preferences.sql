begin;
insert into app.items(id,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at)
select '99417100-0000-4000-8000-000000000001'::uuid,994171,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'shipping preferences fixture',1000,'ヤフオク','メルカリ','123456',now(),now();
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
select id,'メルカリ','mercari-1','m994171','https://jp.mercari.com/item/m994171','m994171:current' from app.items where lot_seq=994171;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result,created_at)
select gen_random_uuid(),id,deliverer_id,'listing','メルカリ','mercari-1',status,updated_at,
 '{"shippingMethod":"ゆうゆうメルカリ便","size":"100","weightKg":"10","dropoff":"ローソン","category":"ブルーレイレコーダー","photos":["PRIVATE_PHOTO"]}',
 'succeeded','{"external_id":"m994171"}',clock_timestamp()-interval '2 hours' from app.items where lot_seq=994171;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result,created_at)
select gen_random_uuid(),id,deliverer_id,'shipping_code','メルカリ','mercari-1',status,updated_at,
 '{"trade_key":"m994171:current","shippingMethod":"ゆうゆうメルカリ便","size":"140","dropoff":"郵便局"}',
 'succeeded','{}',clock_timestamp()-interval '1 hour' from app.items where lot_seq=994171;
-- Old trades, failed choices and another listing must not replace the current choice.
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result)
select gen_random_uuid(),i.id,i.deliverer_id,v.kind,'メルカリ','mercari-1',i.status,i.updated_at,v.payload::jsonb,v.status,v.result::jsonb
from app.items i cross join (values
 ('shipping_code','{"trade_key":"m994171:old","size":"60"}','succeeded','{}'),
 ('shipping_code','{"trade_key":"m994171:current","size":"80"}','failed','{}'),
 ('listing','{"size":"80","shippingMethod":"らくらくメルカリ便"}','succeeded','{"external_id":"m994170"}')
) v(kind,payload,status,result) where i.lot_seq=994171;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status)
select gen_random_uuid(),id,deliverer_id,'message_sync','メルカリ','mercari-1',status,updated_at,'{}','succeeded'
from app.items cross join generate_series(1,15) where lot_seq=994171;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare c jsonb:=app.seller_operation_context((select id from app.items where lot_seq=994171));begin
 if c#>>'{shipping_defaults,size}'<>'140' or c#>>'{shipping_defaults,dropoff}'<>'郵便局' or c#>>'{shipping_defaults,shippingMethod}'<>'ゆうゆうメルカリ便' or c#>>'{shipping_defaults,weightKg}'<>'10' then raise exception 'Reviewed shipping settings were lost or stale settings replaced them';end if;
 if jsonb_array_length(c->'operations')<>12 or c::text like '%PRIVATE_PHOTO%' then raise exception 'Shipping context exposes full listing payload or ignores bounded history';end if;
end $$;
reset role;
update app.seller_listings set trade_key='m994171:next' where external_id='m994171';
set local role authenticated;
do $$declare c jsonb:=app.seller_operation_context((select id from app.items where lot_seq=994171));begin
 if c#>>'{shipping_defaults,size}'<>'100' or c#>>'{shipping_defaults,dropoff}'<>'ローソン' then raise exception 'Previous trade shipping choice carried into a new trade';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin if app.seller_operation_context('99417100-0000-4000-8000-000000000001') is not null then raise exception 'Unassigned worker can read shipping context';end if;end $$;
reset role;
do $$begin if has_function_privilege('anon','app.seller_operation_context(uuid)','execute') then raise exception 'Anonymous shipping context access';end if;end $$;
rollback;
