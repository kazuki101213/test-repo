begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
values(998981,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-40,'verified shipping fixture',1000,'メルカリ','メルカリ');
update app.items set status='取引中',seller_trade_key='fixture-current' where lot_seq=998981;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
select id,'メルカリ','mercari-2','m99998100001','https://jp.mercari.com/item/m99998100001','fixture-current' from app.items where lot_seq=998981;
do $$
declare item uuid;op uuid;before_date date;attempt_status text;
begin
 select id,shipped_on into item,before_date from app.items where lot_seq=998981;
 if not exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then raise exception 'Fixture request missing';end if;
 -- A failed or uncertain attempt never closes a request.
 foreach attempt_status in array array['failed','uncertain'] loop
  op:=gen_random_uuid();
  insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload)
  select op,id,purchaser_id,'ship_notice','メルカリ','mercari-2',status,updated_at,'{"trade_key":"fixture-current"}' from app.items where id=item;
  update app.seller_operations set status=attempt_status,result='{"notified":true}' where id=op;
  if not exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then raise exception 'Unverified operation closed request';end if;
  update app.seller_operations set status='failed' where id=op;
 end loop;
 -- A successful old trade, or a success without notification proof, cannot close it.
 op:=gen_random_uuid();
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload)
 select op,id,purchaser_id,'ship_notice','メルカリ','mercari-2',status,updated_at,'{"trade_key":"fixture-old"}' from app.items where id=item;
 update app.seller_operations set status='succeeded',result='{"notified":true}' where id=op;
 if not exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then raise exception 'Old trade closed current request';end if;
 update app.seller_operations set payload='{"trade_key":"fixture-current"}',result='{"notified":false}' where id=op;
 if not exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then raise exception 'Missing proof closed request';end if;
 update app.seller_operations set result='{"notified":true,"already_notified":true}' where id=op;
 if exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then raise exception 'Verified current notice did not close request';end if;
 if (select shipped_on from app.items where id=item) is distinct from before_date then raise exception 'Dispatch date was invented';end if;
 -- No old date is erased or rewritten when the existing date belongs to history.
 update app.items set shipped_on=current_date-30 where id=item;
 insert into app.delivery_shipping_tasks(item_id,created_at) values(item,clock_timestamp()-interval '1 minute');
 update app.seller_operations set created_at=clock_timestamp(),result='{"notified":true}' where id=op;
 if exists(select 1 from app.delivery_shipping_tasks where item_id=item and resolved_at is null) then raise exception 'Current verified request remained';end if;
 if (select shipped_on from app.items where id=item)<>current_date-30 then raise exception 'Historical dispatch date changed';end if;
end $$;
rollback;

