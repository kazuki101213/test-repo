begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.delivery_line_links(staff_id,line_user_id) select id,'U'||repeat('3',32) from app.staff where code='DD';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,marketplace_url,inspected_at,product_registered_at,status)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'LINE automatic fixture',1000,'メルカリ','メルカリ',
 'm'||n::text,'https://jp.mercari.com/item/m'||n,now(),now(),'出品中' from generate_series(998741,998743) n;
create temporary table line_probe as select id,lot_seq from app.items where lot_seq between 998741 and 998743 and not is_accessory;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
 select id,'メルカリ','mercari-1','m'||lot_seq,'https://jp.mercari.com/transaction/m'||lot_seq,'m'||lot_seq||':2026-10-24T12:00' from line_probe;
update app.items i set seller_trade_key=l.trade_key from app.seller_listings l where l.item_id=i.id and i.id in(select id from line_probe);
-- Past tasks are not backfilled when enabled.
update app.items set status='取引中' where lot_seq=998743;
update app.delivery_line_settings set enabled=true;
update app.items set status='取引中' where lot_seq in(998741,998742);
do $$begin
 if (select count(*) from app.delivery_line_outbox)<>2 then raise exception 'Old requests were broadcast or new requests missing';end if;
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Missing photos/code could send';end if;
 if exists(select 1 from line_probe where lot_seq in(998741,998742) and (app.line_shipping_context(id)->>'requiresPhotos'<>'true' or app.line_shipping_context(id)->>'photosReady'<>'false')) then raise exception 'Missing preparation not exposed';end if;
 if (select count(*) from jsonb_array_elements(app.read_resource_snapshot('admin_shipping_tasks')->'rows') r where r->>'item_id' in(select id::text from line_probe where lot_seq in(998741,998742)) and r->>'line_message'='通知写真を指定してください')<>2 then raise exception 'New pending requests hidden for 24 hours';end if;
end $$;
insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind)
 select p.id,'fixture/'||p.lot_seq||'-'||v||'.jpg',(select id from app.staff where code='DD'),'product' from line_probe p cross join generate_series(1,2) v;
do $$declare i uuid;front uuid;model uuid;foreign_photo uuid;prepared jsonb;begin
 select id into i from line_probe where lot_seq=998741;
 select id into front from app.item_photos where item_id=i order by storage_path limit 1;
 select id into model from app.item_photos where item_id=i order by storage_path desc limit 1;
 select p.id into foreign_photo from app.item_photos p join line_probe i on i.id=p.item_id where i.lot_seq=998742 limit 1;
 begin perform app.save_line_shipping_preferences(i,front,foreign_photo,'{}');raise exception 'Foreign photo accepted';
 exception when raise_exception then if sqlerrm='Foreign photo accepted' then raise;end if;end;
 perform app.save_line_shipping_preferences(i,front,model,'{"shippingMethod":"らくらくメルカリ便","size":"100","dropoff":"セブンイレブン","category":"小物"}');
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'1' then raise exception 'Valid per-item preferences did not queue code: %',prepared;end if;
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);if prepared->>'queued'<>'0' then raise exception 'Code queued twice';end if;
 if exists(select 1 from app.seller_operations where item_id=i and kind<>'shipping_code') then raise exception 'Automatic flow queued a business action';end if;
end $$;
-- Service dispatch reads only the media it needs, without opening the UI context.
set local role service_role;
select app.line_shipping_media(o.id) from app.delivery_line_outbox o;
reset role;
-- The same persisted successful code is used by the app and by LINE.
update app.seller_operations set status='succeeded',result='{"qr_code":"fixture-code"}' where item_id=(select id from line_probe where lot_seq=998741) and kind='shipping_code';
do $$declare result record;other_count integer;begin
 select * into result from app.claim_delivery_line() where eligible;
 if result.id is null or result.payload->'media'->>'serial'<>'998741' then raise exception 'Prepared request not claimable';end if;
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Lease claimed twice';end if;
 if app.prepare_delivery_line_message(result.id,gen_random_uuid(),'{"itemId":"wrong"}') then raise exception 'Wrong lease prepared';end if;
 if not app.prepare_delivery_line_message(result.id,result.lease,'{"itemId":"fixture","images":["a","b","c"]}') then raise exception 'Preparation failed';end if;
 perform app.finish_delivery_line(result.id,result.lease,'pending',503);
 update app.delivery_line_outbox set next_attempt_at=now() where id=result.id;
 select * into result from app.claim_delivery_line() where eligible;
 if result.payload->>'itemId'<>'fixture' then raise exception 'Retry changed original payload';end if;
 update app.items set shipped_on=current_date where id=(select id from line_probe where lot_seq=998741);
 if app.prepare_delivery_line_message(result.id,result.lease,'{}') then raise exception 'Shipped item could send';end if;
 perform app.finish_delivery_line(result.id,result.lease,'cancelled',null);
end $$;
-- A small item without a saved size sends its two product photos, no code job.
do $$declare i uuid;front uuid;model uuid;r record;prepared jsonb;begin
 select id into i from line_probe where lot_seq=998742;
 select id into front from app.item_photos where item_id=i order by storage_path limit 1;
 select id into model from app.item_photos where item_id=i order by storage_path desc limit 1;
 perform app.save_line_shipping_preferences(i,front,model,'{}');
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'0' or exists(select 1 from app.seller_operations where item_id=i) then raise exception 'Unset small size accessed marketplace';end if;
 select * into r from app.claim_delivery_line() where eligible;
 if r.payload->'media'->>'withoutBarcode'<>'size_unset' or r.payload->'media'->>'codeOperationId' is not null then raise exception 'Unset size did not prepare photo-only LINE';end if;
 perform app.finish_delivery_line(r.id,r.lease,'sent',200);
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Photo-only request sent twice';end if;
 if app.line_model_shipping_size('BDP-S6700','')<>'100' or app.line_model_shipping_size('VZ239HR','')<>'140'
 or app.line_model_shipping_size('TT-4K100','')<>'100' or app.line_model_shipping_size('Aprica ラクリス','') is not null
 or app.line_model_shipping_size(null,'中古 DMR-BRZ1020')<>'100'
 or app.line_model_shipping_size(null,'XDMR-BRZ1020Y') is not null then raise exception 'Fixed size classification mismatch';end if;
end $$;
-- Completed shipments teach only the exact small product, never a generic title.
update app.items set asin='B0SMALL001' where lot_seq=998741;
select app.remember_line_shipping_size((select id from line_probe where lot_seq=998741));
update app.items set asin='B0SMALL001' where lot_seq=998742;
do $$declare target uuid;begin
 select id into target from line_probe where lot_seq=998742;
 if app.line_learned_shipping_size(target)<>'100' then raise exception 'Same-ASIN shipment was not learned';end if;
 if app.seller_operation_context(target)->'shipping_defaults'->>'size'<>'100' then raise exception 'Learned size missing in shipping panel';end if;
 update app.items set asin='B0OTHER001' where id=target;
 if app.line_learned_shipping_size(target) is not null then raise exception 'Different product inherited size';end if;
 update app.items set title='リモコン',asin=null where id=target;
 if app.line_learned_shipping_size(target) is not null then raise exception 'Generic title inherited size';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 if exists(select 1 from app.delivery_line_preferences) then raise exception 'Other assignee read preferences';end if;
 begin perform app.line_shipping_context('00000000-0000-0000-0000-000000000000');raise exception 'Foreign context accepted';exception when insufficient_privilege then null;end;
 if has_function_privilege('authenticated','app.line_shipping_media(uuid)','execute') then raise exception 'Private media exposed';end if;
end $$;
rollback;
