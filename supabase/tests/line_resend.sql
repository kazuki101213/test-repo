begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.delivery_line_links(staff_id,line_user_id) select id,'U'||repeat('9',32) from app.staff where code='DD';
update app.delivery_line_settings set enabled=true;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status)
values(994861,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'resend fixture',1000,'メルカリ','メルカリ','resend-purchase-tracking',now(),now(),'出品中');
create temporary table resend_probe as select id from app.items where lot_seq=994861;
grant select on resend_probe to authenticated;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
select id,'メルカリ','mercari-1','m994861','https://jp.mercari.com/transaction/m994861','m994861:2026-11-05T12:00' from resend_probe;
update app.items set status='取引中',seller_trade_key='m994861:2026-11-05T12:00' where id=(select id from resend_probe);
insert into app.item_photos(item_id,storage_path,photo_kind) select id,'resend-fixture/'||n||'.jpg','product' from resend_probe cross join generate_series(1,2)n;
select app.save_line_shipping_preferences((select id from resend_probe),(select id from app.item_photos where item_id=(select id from resend_probe) order by storage_path limit 1),(select id from app.item_photos where item_id=(select id from resend_probe) order by storage_path desc limit 1),'{}');
update app.delivery_line_outbox o set state='sent',sent_at=now(),attempts=1 from app.delivery_shipping_tasks t where o.task_id=t.id and t.item_id=(select id from resend_probe);
set local role authenticated;
do $$declare r jsonb;item uuid:=(select id from resend_probe);begin
 r:=app.request_delivery_line_resend(item);
 if r->>'queued'<>'true' or r->>'codeRequired'<>'false' then raise exception 'Valid trade could not request resend: %',r;end if;
 begin
  perform app.request_delivery_line_resend(item);
  raise exception 'Duplicate resend accepted';
 exception when raise_exception then
  if sqlerrm<>'再送できる送信済み通知がありません' then raise;end if;
 end;
 perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',true);
 begin perform app.request_delivery_line_resend(item);raise exception 'Foreign staff resend accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$begin
 if (select count(*) from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id where t.item_id=(select id from resend_probe))<>1
 then raise exception 'Resend duplicated the notification';end if;
 if position(chr(65533) in pg_get_functiondef('app.request_delivery_line_resend(uuid)'::regprocedure))>0 then raise exception 'Corrupt resend function';end if;
 if has_function_privilege('anon','app.request_delivery_line_resend(uuid)','execute') then raise exception 'Anonymous resend enabled';end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
update app.items set shipped_on=current_date where id=(select id from resend_probe);
do $$begin
 begin perform app.request_delivery_line_resend((select id from resend_probe));raise exception 'Shipped trade resend accepted';
 exception when raise_exception then if sqlerrm<>'現在の未発送取引を確認できません' then raise;end if;end;
end $$;
rollback;
