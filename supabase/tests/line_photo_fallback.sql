begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.delivery_line_links(staff_id,line_user_id)
 select id,'U'||repeat('8',32) from app.staff where code='DD';
update app.delivery_line_settings set enabled=true;
insert into app.products(product_no,asin,model_no,maker,shipping_category,shipping_size)
 values(899996,'BFALLBACK1','fallback fixed','fixture','ブ','100');
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status,inspected_at,product_registered_at)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'LINE fallback fixture',1000,'メルカリ','メルカリ','出品中',now(),now()
 from generate_series(998761,998762)n;
update app.items set product_id=(select id from app.products where asin='BFALLBACK1') where lot_seq=998762;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
 select id,'メルカリ','mercari-1','m'||lot_seq,'https://jp.mercari.com/item/m'||lot_seq,'m'||lot_seq||':current'
 from app.items where lot_seq in(998761,998762);
update app.items set status='取引中',seller_trade_key='m'||lot_seq||':current' where lot_seq in(998761,998762);
insert into app.item_photos(item_id,storage_path,photo_kind,created_at)
 select id,'fallback/'||lot_seq||'/'||n||'.jpg','product',now()+n*interval '1 second'
 from app.items cross join generate_series(1,3)n where lot_seq=998761;
insert into app.item_photos(item_id,storage_path,photo_kind,created_at)
 select id,'fallback/packing.jpg','packing',now()-interval '2 seconds' from app.items where lot_seq=998761;

do $$declare item uuid;outbox uuid;media jsonb;expected jsonb;front uuid;model uuid;begin
 select id into item from app.items where lot_seq=998761;
 select o.id into outbox from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id where t.item_id=item;
 media:=app.line_shipping_media(outbox);
 if media is null or media->'photoPaths'<>'["fallback/998761/1.jpg","fallback/998761/2.jpg"]'::jsonb
  or media->>'codeOperationId' is not null or media->>'withoutBarcode'<>'size_unset'
 then raise exception 'Unconfigured product photos did not prepare the exact automatic notification: %',media;end if;
 select id into front from app.item_photos where item_id=item and storage_path='fallback/998761/3.jpg';
 select id into model from app.item_photos where item_id=item and storage_path='fallback/998761/1.jpg';
 perform app.save_line_shipping_preferences(item,front,model,'{}');
 media:=app.line_shipping_media(outbox);
 if media->'photoPaths'<>'["fallback/998761/3.jpg","fallback/998761/1.jpg"]'::jsonb then raise exception 'Explicit photo order was replaced';end if;
 delete from app.delivery_line_preferences where item_id=item;
 delete from app.item_photos where item_id=item;
 if app.line_shipping_media(outbox)->'photoPaths'<>'[]'::jsonb then raise exception 'Missing photos blocked the text/app-link request';end if;
end $$;

do $$declare item uuid;outbox uuid;op uuid:=gen_random_uuid();begin
 select id into item from app.items where lot_seq=998762;
 select o.id into outbox from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id where t.item_id=item;
 if app.line_fixed_shipping_size(item)<>'100' then raise exception 'Fixed-size fixture missing';end if;
 if app.line_shipping_media(outbox) is not null then raise exception 'Required current code was bypassed';end if;
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result)
 select op,id,deliverer_id,'shipping_code','メルカリ','mercari-1',status,updated_at,'{"trade_key":"old-trade"}','succeeded','{"qr_code":"fixture-code"}' from app.items where id=item;
 if app.line_shipping_media(outbox) is not null then raise exception 'Old-trade code was reused';end if;
 update app.seller_operations set payload='{"trade_key":"m998762:current"}' where id=op;
 if app.line_shipping_media(outbox)->>'codeOperationId' is distinct from op::text
  or app.line_shipping_media(outbox)->'photoPaths'<>'[]'::jsonb then raise exception 'Verified current code was blocked by optional photos';end if;
 update app.items set shipped_on=current_date where id=item;
 if app.line_shipping_media(outbox) is not null then raise exception 'Shipped product became eligible';end if;
end $$;

do $$declare r record;counted integer:=0;begin
 for r in select * from app.claim_delivery_line() loop
  counted:=counted+1;
  if not r.eligible or r.payload->'media'->>'serial'<>'998761' then raise exception 'Wrong request claimed';end if;
  perform app.finish_delivery_line(r.id,r.lease,'sent',200);
 end loop;
 if counted<>1 then raise exception 'Missing-media request did not reach dispatch';end if;
 if exists(select 1 from app.claim_delivery_line()) then raise exception 'Notification replayed';end if;
 if has_function_privilege('anon','app.line_shipping_media(uuid)','execute') or has_function_privilege('authenticated','app.line_shipping_media(uuid)','execute') then raise exception 'Private media helper exposed';end if;
end $$;
rollback;
