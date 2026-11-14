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
create temporary table resend_key_probe as
select o.id,o.line_retry_key as initial_key,null::uuid as first_key
from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id
where t.item_id=(select id from resend_probe);
do $$begin
 if (select count(*) from resend_key_probe)<>1 or (select initial_key from resend_key_probe) is null
 then raise exception 'Initial retry key is missing';end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare item uuid:=(select id from resend_probe);begin
 begin
  perform app.line_shipping_context(item);
  raise exception 'Assigned delivery staff opened administrator LINE settings';
 exception when insufficient_privilege then null;end;
 begin
  perform app.save_line_shipping_preferences(item,null,null,'{}');
  raise exception 'Assigned delivery staff changed administrator LINE settings';
 exception when insufficient_privilege then null;end;
 begin
  perform app.request_delivery_line_resend(item);
  raise exception 'Assigned delivery staff resent administrator LINE notification';
 exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare r jsonb;item uuid:=(select id from resend_probe);begin
 if app.line_shipping_context(item)->>'state' is distinct from 'sent' then
  raise exception 'Administrator cannot see the sent LINE notification for another staff member';
 end if;
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
 update resend_key_probe k set first_key=o.line_retry_key from app.delivery_line_outbox o where o.id=k.id;
 if (select first_key=initial_key from resend_key_probe) is distinct from false
 then raise exception 'A deliberate resend reused the accepted retry key';end if;
 if (select state from app.delivery_line_outbox where id=(select id from resend_key_probe))<>'pending'
 then raise exception 'First resend did not queue';end if;
end $$;
update app.delivery_line_outbox set state='sent',sent_at=now() where id=(select id from resend_key_probe);
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
do $$declare r jsonb;begin
 r:=app.request_delivery_line_resend((select id from resend_probe));
 if r->>'queued'<>'true' then raise exception 'Second deliberate resend was rejected';end if;
end $$;
reset role;
do $$begin
 if (select o.line_retry_key=k.first_key from app.delivery_line_outbox o join resend_key_probe k on k.id=o.id)
  is distinct from false then raise exception 'Second resend reused the first resend key';end if;
 if (select o.line_retry_key=k.initial_key from app.delivery_line_outbox o join resend_key_probe k on k.id=o.id)
  is distinct from false then raise exception 'Second resend reused the original key';end if;
 if not exists(select 1 from pg_indexes where schemaname='app' and tablename='delivery_line_outbox' and indexname='delivery_line_outbox_retry_key_unique')
 then raise exception 'Retry key uniqueness is not enforced';end if;
end $$;
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

begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.delivery_line_links(staff_id,line_user_id)
 select id,'U'||repeat('8',32) from app.staff where code='DD';
update app.delivery_line_settings set enabled=true;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status)
values(994862,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date,'LINE before barcode fixture',1000,'メルカリ','メルカリ','出品中');
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
 select id,'メルカリ','mercari-2','m123994862','https://jp.mercari.com/transaction/m123994862','trade-994862'
 from app.items where lot_seq=994862;
update app.items set status='取引中',seller_trade_key='trade-994862' where lot_seq=994862;
update app.delivery_line_outbox o set state='sent',sent_at=now(),attempts=1
 from app.delivery_shipping_tasks t where o.task_id=t.id and t.item_id=(select id from app.items where lot_seq=994862);
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload)
 select '99486200-0000-4000-8000-000000000001',id,deliverer_id,'shipping_code','メルカリ','mercari-2',status,updated_at,
 '{"trade_key":"trade-994862","shippingMethod":"らくらくメルカリ便","size":"宅急便60〜160","dropoff":"セブンイレブン"}'
 from app.items where lot_seq=994862;
update app.seller_operations set status='succeeded',finished_at=clock_timestamp(),result='{"qr_code":"fixture-issued-code"}'
 where id='99486200-0000-4000-8000-000000000001';
do $$declare item uuid; o app.delivery_line_outbox; r jsonb; code_id uuid:='99486200-0000-4000-8000-000000000001';begin
 select id into item from app.items where lot_seq=994862;
 select q.* into o from app.delivery_line_outbox q join app.delivery_shipping_tasks t on t.id=q.task_id where t.item_id=item;
 if o.code_issue_operation_id is distinct from code_id or o.state is distinct from 'sent' then
  raise exception 'Issuance failed to associate the code with an already-sent LINE notification';
 end if;
 -- Reproduce a pre-fix outbox whose photo message was sent before issuance.
 update app.delivery_line_outbox set code_issue_operation_id=null where id=o.id;
 r:=app.request_delivery_line_resend(item);
 if r->>'queued' is distinct from 'true' or r->>'codeRequired' is distinct from 'true'
  or app.line_shipping_media(o.id)->>'codeOperationId' is distinct from code_id::text then
  raise exception 'Verified existing code was not included in the resend: %',r;
 end if;
 if not exists(select 1 from app.delivery_line_outbox where id=o.id and state='pending' and line_retry_key<>o.line_retry_key) then
  raise exception 'Resend failed to rotate the LINE retry key';
 end if;
 if (select shipped_on from app.items where id=item) is null
  or exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then
  raise exception 'Resend changed the dispatch date or reopened the task';
 end if;
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,result)
  select gen_random_uuid(),id,deliverer_id,'ship_notice','メルカリ','mercari-2',status,updated_at,
   '{"trade_key":"trade-994862"}','succeeded','{"notified":true}' from app.items where id=item;
 if app.line_shipping_eligible(o.id) then raise exception 'Already-notified transaction can still send LINE';end if;
 begin
  perform app.request_delivery_line_resend(item);
  raise exception 'Already-notified transaction accepted a resend';
 exception when raise_exception then
  if sqlerrm<>'現在の未発送取引を確認できません' then raise;end if;
 end;
end $$;
rollback;
