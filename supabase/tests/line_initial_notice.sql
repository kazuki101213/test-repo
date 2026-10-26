begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.delivery_line_settings set enabled=true;
insert into app.delivery_line_links(staff_id,line_user_id) select id,'U'||repeat('4',32) from app.staff where code='DD';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,inspected_at,product_registered_at,status)
select 998751,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'SONY BDZ-FBW1000',0,'メルカリ','メルカリ',now(),now(),'出品中';
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
select id,'メルカリ','mercari-1','m998751','https://jp.mercari.com/transaction/m998751','m998751:fixture' from app.items where lot_seq=998751;
update app.items set seller_trade_key='m998751:fixture',status='取引中' where lot_seq=998751;
do $$declare r record;again record;item uuid;front uuid;model uuid;notice jsonb;key uuid;begin
 select id into item from app.items where lot_seq=998751;
 select * into r from app.claim_delivery_line();
 if r.id is null or r.payload->>'initialNotice'<>'true' or r.payload->'images'<>'[]'::jsonb then raise exception 'Missing photos blocked initial notice';end if;
 key:=(r.payload->>'deliveryRetryKey')::uuid;
 if key=r.id then raise exception 'Initial and media share retry key';end if;
 notice:=r.payload;
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Initial lease duplicated';end if;
 if app.prepare_delivery_line_message(r.id,gen_random_uuid(),notice) then raise exception 'Wrong lease accepted';end if;
 if not app.prepare_delivery_line_message(r.id,r.lease,notice) then raise exception 'Initial prepare rejected';end if;
 perform app.finish_delivery_line(r.id,r.lease,'pending',503);
 perform app.retry_delivery_line();
 if (select state from app.delivery_line_outbox where id=r.id)<>'pending' then raise exception 'Missing media cancelled initial retry';end if;
 update app.items set title='Changed title' where id=item;
 update app.delivery_line_outbox set next_attempt_at=now() where id=r.id;
 select * into again from app.claim_delivery_line();
 if again.payload is distinct from notice then raise exception 'Initial retry changed body or key';end if;
 -- Media becoming ready during a retry must not change the initial message.
 insert into app.item_photos(item_id,storage_path,uploaded_by,photo_kind) values
 (item,'fixture/initial-front.jpg',(select id from app.staff where code='DD'),'product'),
 (item,'fixture/initial-model.jpg',(select id from app.staff where code='DD'),'product');
 select id into front from app.item_photos where item_id=item and storage_path='fixture/initial-front.jpg';
 select id into model from app.item_photos where item_id=item and storage_path='fixture/initial-model.jpg';
 perform app.save_line_shipping_preferences(item,front,model,'{"shippingMethod":"らくらくメルカリ便","size":"100","dropoff":"セブンイレブン","category":"ブルーレイレコーダー"}');
 perform app.extension_prepare_line_shipping(array['mercari-1']);
 update app.seller_operations set status='succeeded',result='{"qr_code":"fixture-code"}' where item_id=item and kind='shipping_code';
 perform app.finish_delivery_line(again.id,again.lease,'sent',200);
 if not exists(select 1 from app.delivery_line_outbox where id=r.id and initial_sent_at is not null and initial_message_payload=notice and state='pending' and attempts=0 and delivery_phase='media') then raise exception 'Initial receipt lost or media marked sent too early';end if;
 select * into r from app.claim_delivery_line();
 if r.payload->>'imageFollowup'<>'true' or r.payload->'media'->>'codeOperationId' is null or r.payload ? 'initialNotice' then raise exception 'Follow-up missing or initial repeated';end if;
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Media lease duplicated';end if;
 if not app.prepare_delivery_line_message(r.id,r.lease,'{"images":["front","model","code"],"imageFollowup":true}') then raise exception 'Follow-up prepare rejected';end if;
 perform app.finish_delivery_line(r.id,r.lease,'sent',200);
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Completed request repeated';end if;
 if exists(select 1 from app.seller_operations where item_id=item and kind<>'shipping_code') then raise exception 'Initial notice created a business operation';end if;
 if has_function_privilege('authenticated','app.line_initial_notice_payload(uuid)','execute') then raise exception 'Private dispatcher exposed';end if;
end $$;
rollback;
