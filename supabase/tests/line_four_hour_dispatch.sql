-- Disposable database: test the same RPC called after the four-hour patrol.
-- HTTP is captured locally; no LINE or marketplace request leaves this test.
begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
create schema if not exists net;
create temporary table line_patrol_http_calls(url text,body jsonb);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
returns bigint language plpgsql as $$begin
 insert into line_patrol_http_calls values($1,$3);return 999771;
end $$;
insert into vault.secrets(name,secret) values('delivery_push_dispatch_token','fixture'),('delivery_push_project_url','https://fixture.invalid');
update app.delivery_line_settings set enabled=false;
insert into app.delivery_line_links(staff_id,line_user_id) select id,'U'||repeat('7',32) from app.staff where code='DD';
insert into app.products(product_no,asin,model_no,maker,shipping_category,shipping_size)
 values(899771,'BPATROL001','patrol fixed-size fixture','fixture','ブ','100');
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status,inspected_at,product_registered_at)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'four-hour LINE fixture',1000,'メルカリ','メルカリ','出品中',now(),now()
 from generate_series(998771,998773)n;
update app.items set product_id=(select id from app.products where asin='BPATROL001') where lot_seq in(998772,998773);
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
 select id,'メルカリ','mercari-1','m'||lot_seq,'https://jp.mercari.com/item/m'||lot_seq,'m'||lot_seq||':current'
 from app.items where lot_seq between 998771 and 998773;
insert into app.item_photos(item_id,storage_path,photo_kind)
 select id,'patrol/998771/'||n||'.jpg','product' from app.items cross join generate_series(1,6)n where lot_seq=998771;
select app.save_line_shipping_preferences(id,null,null,'{"shippingMethod":"らくらくメルカリ便","size":"100","dropoff":"セブンイレブン","category":"ブルーレイレコーダー"}') from app.items where lot_seq=998772;
update app.items set status='取引中',seller_trade_key='m'||lot_seq||':current' where lot_seq between 998771 and 998773;
update app.delivery_line_settings set enabled=true;

do $$declare prepared jsonb;request uuid;r record;counted integer:=0;calls integer;begin
 -- 2294b equivalent: six photos, no explicit selection, no catalog code size.
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'1' then raise exception 'Photo-less fixed-size request did not prepare exactly one code: %',prepared;end if;
 if (select count(*) from line_patrol_http_calls where url='https://fixture.invalid/functions/v1/delivery-line' and body='{"action":"dispatch"}')<>1 then raise exception 'Four-hour preparation did not dispatch the ready notification';end if;
 if exists(select 1 from app.seller_operations q join app.items i on i.id=q.item_id where i.lot_seq=998771) then raise exception 'Unknown-size product caused an unnecessary code operation';end if;
 if not exists(select 1 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id where i.lot_seq=998773 and o.last_error='配送サイズ・発送場所を保存してください') then raise exception 'Missing shipping settings were silently excluded';end if;
 for r in select * from app.claim_delivery_line() loop
  counted:=counted+1;request:=r.id;
  if not r.eligible or r.payload->'media'->>'serial'<>'998771' or jsonb_array_length(r.payload->'media'->'photoPaths')<>2 then raise exception 'Periodic dispatch selected the wrong item/media';end if;
  perform app.finish_delivery_line(r.id,r.lease,'sent',200);
 end loop;
 if counted<>1 then raise exception 'Ready photo-unselected request never reached dispatch';end if;
 -- This fixture simulates the LINE consumer directly. Defer the independent
 -- photo worker so its legitimate HTTP preparation is not mistaken for a push.
 update app.line_photo_selections q set next_attempt_at=now()+interval '1 hour'
 where q.item_id in(select id from app.items where lot_seq between 998771 and 998773);
 select count(*) into calls from line_patrol_http_calls;
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'0' or (select count(*) from app.seller_operations q join app.items i on i.id=q.item_id where i.lot_seq=998772)<>1 then raise exception 'Patrol duplicated a code request';end if;
 if (select count(*) from line_patrol_http_calls)<>calls or exists(select 1 from app.claim_delivery_line()) then raise exception 'Patrol resent an accepted notification';end if;
 if (select attempts from app.delivery_line_outbox where id=request)<>1 then raise exception 'Sent attempt count changed';end if;
 update app.seller_operations q set status='uncertain',finished_at=now(),
   result=jsonb_build_object('phase','read_shipping_code','note','配送コードの画像を確認できません。再発行しません')
 where q.item_id=(select id from app.items where lot_seq=998772);
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'0' then raise exception 'Uncertain code issuance was retried';end if;
 update app.seller_operations q set status='failed',finished_at=now(),
   result=jsonb_build_object('phase','prepare','note','取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません')
 where q.item_id=(select id from app.items where lot_seq=998772);
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'1' then raise exception 'Read-only Mercari timeout did not retry';end if;
 update app.seller_operations q set status='failed',finished_at=now(),
   result=jsonb_build_object('phase','prepare','note','取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません')
 where q.item_id=(select id from app.items where lot_seq=998772) and q.status='queued';
 prepared:=app.extension_prepare_line_shipping(array['mercari-1']);
 if prepared->>'queued'<>'0' then raise exception 'Mercari timeout retried more than once';end if;
end $$;
rollback;
