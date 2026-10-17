begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'four-account sales fixture',1000,'ヤフオク','FBA','123456',now(),now()
from generate_series(996110,996118) n;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
select 996110,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'linked accessory',100,'ヤフオク',true;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare account text; serial integer:=996110; ext text; row jsonb; result text; v_plan jsonb; before_count integer:=(select count(*) from app.items);begin
 foreach account in array array['mercari-1','mercari-2','auctions-1','auctions-2'] loop
  ext:=case when account like 'mercari%' then 'm' else 'u' end||serial::text;
  row:=jsonb_build_object('serial',serial::text,'external_id',ext,'status','販売済','trade_key',ext||':one','sold_on',current_date-1,'sold_price',5000,'payout_amount',4000,'observed_at',now()+interval '1 second');
  v_plan:=app.seller_observation_plan(account,jsonb_build_array(row));
  if v_plan#>>'{0,action}'<>'detail' then raise exception 'Forgotten FBA channel excluded %',account;end if;
  result:=app.sync_seller_observation(account,row);
  if result<>'registered' then raise exception 'Sale rejected % %',account,result;end if;
  if not exists(select 1 from app.items where lot_seq=serial and not is_accessory and sold_on=current_date-1 and sold_price=5000 and payout_amount=4000 and sales_channel::text=case when account like 'mercari%' then 'メルカリ' else 'ヤフオク' end) then raise exception 'Sale channel/amount not corrected';end if;
  if app.seller_observation_plan(account,jsonb_build_array(row))#>>'{0,action}'<>'registered' then raise exception 'Verified sale not cached';end if;
  if app.sync_seller_observation(account,row||jsonb_build_object('status','出品中','observed_at',now()+interval '2 seconds'))<>'protected' then raise exception 'Sold item reopened';end if;
  serial:=serial+1;
 end loop;
 if (select count(*) from app.items)<>before_count then raise exception 'Duplicate inventory created';end if;
 if exists(select 1 from app.items where lot_seq=996110 and is_accessory and (sales_channel<>'メルカリ' or sold_on<>current_date-1 or status<>'販売済')) then raise exception 'Accessory sale not synchronized';end if;
 -- Existing verified values edited by the administrator must not count as registered or be overwritten.
 update app.items set payout_amount=3999 where lot_seq=996110 and not is_accessory;
 row:=jsonb_build_object('serial','996110','external_id','m996110','status','販売済','trade_key','m996110:one','sold_on',current_date-1,'sold_price',5000,'payout_amount',4000,'observed_at',now()+interval '3 seconds');
 if app.seller_observation_plan('mercari-1',jsonb_build_array(row))#>>'{0,action}'<>'detail' then raise exception 'Manually changed sale counted as registered';end if;
 if app.sync_seller_observation('mercari-1',row)<>'conflict' then raise exception 'Conflicting sale overwritten';end if;
 if (select payout_amount from app.items where lot_seq=996110 and not is_accessory)<>3999 then raise exception 'Manual value changed';end if;
 -- Missing and suffix-different serials cannot change numeric-series inventory.
 if app.sync_seller_observation('auctions-2',row||'{"external_id":"u996119","serial":"996114b"}')<>'unmatched' then raise exception 'Suffix ignored';end if;
 if app.sync_seller_observation('auctions-2',row||'{"external_id":"u996119","serial":"999999"}')<>'unmatched' then raise exception 'Missing serial guessed';end if;
 -- Purchase confirmation can repair the channel before final sale; a plain listing cannot.
 row:=jsonb_build_object('serial','996114','external_id','u996114','status','出品中','trade_key','u996114:one','observed_at',now()+interval '3 seconds');
 if app.sync_seller_observation('auctions-2',row)<>'protected' then raise exception 'Unsold listing changed channel';end if;
 if app.sync_seller_observation('auctions-2',row||'{"status":"取引中"}')<>'updated' then raise exception 'Paid trade not attached';end if;
 if not exists(select 1 from app.items where lot_seq=996114 and status='取引中' and sales_channel='ヤフオク') then raise exception 'Trade channel not repaired';end if;
end $$;
-- Non-default accounts must be used for shipping/messages, but publication defaults remain unchanged.
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare item app.items; op uuid;begin
 select * into item from app.items where lot_seq=996114;
 op:=app.queue_seller_operation(item.id,'message_sync',jsonb_build_object('trade_key','u996114:one','expected_revision',item.updated_at),gen_random_uuid());
 if (select account_id from app.seller_operations where id=op)<>'auctions-2' then raise exception 'Shipping/message routed to wrong account';end if;
 begin perform app.seller_observation_plan('mercari-1','[]');raise exception 'Worker sale access allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$begin
 if has_function_privilege('anon','app.seller_observation_plan(text,jsonb)','execute') or has_function_privilege('authenticated','app.resolve_seller_observation_item(text,jsonb)','execute') then raise exception 'Private resolution exposed';end if;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at)
select '996118'||suffix||'-AADD-20261001-1000',996118,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'suffix matching fixture',1000,'ヤフオク','FBA','123456',now(),now()
from unnest(array['a','aa','b']) suffix;
set local role authenticated;
do $$declare suffix text;row jsonb;ext text;idx int:=0;begin
 foreach suffix in array array['a','aa','B'] loop
  idx:=idx+1;ext:='m996118'||idx;
  row:=jsonb_build_object('serial','996118'||suffix,'external_id',ext,'status','販売済','trade_key',ext||':one','sold_on',current_date-1,'sold_price',5000,'payout_amount',4000,'observed_at',clock_timestamp()+interval '1 second');
  if app.seller_observation_plan('mercari-2',jsonb_build_array(row))#>>'{0,action}'<>'detail' then raise exception 'Suffix positive match excluded %',suffix;end if;
  if app.sync_seller_observation('mercari-2',row)<>'registered' then raise exception 'Suffix sale not registered %',suffix;end if;
  if not exists(select 1 from app.items where lower(app.product_serial(sku,lot_seq))='996118'||lower(suffix) and sold_on=current_date-1 and sales_channel='メルカリ') then raise exception 'Wrong suffix updated';end if;
 end loop;
 if exists(select 1 from app.items where app.product_serial(sku,lot_seq)='996118' and sold_on is not null) then raise exception 'Numeric row was merged with suffixes';end if;
end $$;
reset role;
rollback;
