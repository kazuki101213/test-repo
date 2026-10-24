begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'photo order fixture',1000,'ヤフオク','メルカリ' from generate_series(998751,998752)n;
insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind)
 select id,'fixture/'||lot_seq||'/'||v||'.jpg',deliverer_id,'product' from app.items cross join generate_series(1,2)v where lot_seq in(998751,998752);
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
 select id,'メルカリ','mercari-1','m998751','https://jp.mercari.com/item/m998751','m998751:current' from app.items where lot_seq=998751;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result,created_at)
 select gen_random_uuid(),id,deliverer_id,'listing','メルカリ','mercari-1',status,updated_at,
 '{"photos":["https://fixture.supabase.co/storage/v1/object/sign/item-photos/fixture/998751/2.jpg?token=expired","https://fixture.supabase.co/storage/v1/object/sign/item-photos/fixture/998752/1.jpg?token=foreign","https://fixture.supabase.co/storage/v1/object/sign/item-photos/fixture/998751/1.jpg?token=expired","https://fixture.supabase.co/storage/v1/object/sign/item-photos/fixture/998751/2.jpg?token=duplicate"]}',
 'succeeded','{"external_id":"m998751"}',now()-interval '1 hour' from app.items where lot_seq=998751;
-- A later failed attempt or a different listing must not replace the order.
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result)
 select gen_random_uuid(),i.id,i.deliverer_id,'listing','メルカリ','mercari-1',i.status,i.updated_at,'{"photos":[]}',v.status,jsonb_build_object('external_id',v.external_id)
 from app.items i cross join(values('failed','m998751'),('succeeded','m998753'))v(status,external_id) where lot_seq=998751;
do $$declare item uuid;expected jsonb;actual jsonb;begin
 select id into item from app.items where lot_seq=998751;
 select jsonb_agg(id order by storage_path desc) into expected from app.item_photos where item_id=item;
 actual:=app.line_shipping_context(item)->'photoOrder';
 if actual is distinct from expected then raise exception 'Published order mismatch or foreign/duplicate photo exposed: %',actual;end if;
 if app.line_listing_photo_order((select id from app.items where lot_seq=998752))<>'[]'::jsonb then raise exception 'Unpublished photo order invented';end if;
 if has_function_privilege('authenticated','app.line_listing_photo_order(uuid)','execute') then raise exception 'Private order helper exposed';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 begin perform app.line_shipping_context((select id from app.items where lot_seq=998751));raise exception 'Foreign order exposed';exception when insufficient_privilege then null;end;
end $$;
rollback;
