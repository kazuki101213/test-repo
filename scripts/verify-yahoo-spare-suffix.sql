begin;
-- Run after the migration; every fixture and queued event is rolled back.
create temp table suffix_original_items as select id,to_jsonb(i) data from app.items i;
create temp table suffix_original_spares as select id,to_jsonb(s) data from app.spare_accessories s;
select set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),true);
set local role authenticated;
do $test$
declare owner_id uuid:=app.current_staff_id(); body_id uuid; remote_id uuid; suffix text; serial text; spare_count integer;
begin
 if exists(select 1 from app.items where lot_seq=900100) or exists(select 1 from app.spare_accessories where usage_note like '900100%') then raise exception 'Fixture identity already used'; end if;
 foreach suffix in array array['','a','aa'] loop
  serial:='900100'||suffix;
  insert into app.items(sku,lot_seq,is_accessory,purchaser_id,deliverer_id,title,cost_amount,purchased_at,marketplace)
  values(serial||'-AAAA-20261008-100',900100,false,owner_id,owner_id,'suffix test body',1000,'2026-10-08','ヤフオク') returning id into body_id;
  insert into app.items(sku,lot_seq,is_accessory,purchaser_id,deliverer_id,title,cost_amount,purchased_at,marketplace,work_stream)
  values(serial||'-AAAA-20261008-20',900100,true,owner_id,owner_id,'リモコン',200,'2026-10-08','メルカリ','付属品') returning id into remote_id;
 end loop;
 -- Reject a same-number, different-suffix manual move; preserve the remote.
 select id into remote_id from app.items where sku='900100a-AAAA-20261008-20';
 begin
  perform app.move_inventory_accessory_to_spares(remote_id,jsonb_build_object('title','リモコン','usage_note','900100'));
  raise exception 'Mismatched suffix accepted';
 exception when sqlstate '22023' then null;
 end;
 if not exists(select 1 from app.items where id=remote_id) then raise exception 'Rejected move deleted remote'; end if;
 foreach suffix in array array['','a','aa'] loop
  serial:='900100'||suffix;
  select id into body_id from app.items where sku=serial||'-AAAA-20261008-100';
  perform app.prepare_yahoo_auction_item(body_id);
  perform app.prepare_yahoo_auction_item(body_id);
  select count(*) into spare_count from app.spare_accessories where usage_note=serial and source_sku=serial||'-AAAA-20261008-20';
  if spare_count<>1 then raise exception 'Wrong remote or duplicate for %',serial; end if;
  if exists(select 1 from app.items where sku=serial||'-AAAA-20261008-20') then raise exception 'Remote not moved %',serial; end if;
 end loop;
 -- Without a remote, generated usage still includes the suffix.
 insert into app.items(sku,lot_seq,is_accessory,purchaser_id,deliverer_id,title,cost_amount,purchased_at,marketplace)
 values('900100b-AAAA-20261008-100',900100,false,owner_id,owner_id,'suffix test body',1000,'2026-10-08','ヤフオク') returning id into body_id;
 perform app.prepare_yahoo_auction_item(body_id);
 perform app.prepare_yahoo_auction_item(body_id);
 if (select count(*) from app.spare_accessories where usage_note='900100b')<>1 then raise exception 'Missing-remote suffix failed'; end if;
end $test$;
reset role;
do $check$ begin
 if exists(select 1 from suffix_original_items b left join app.items i using(id) where b.data is distinct from to_jsonb(i)) then raise exception 'Existing inventory changed'; end if;
 if exists(select 1 from suffix_original_spares b left join app.spare_accessories s using(id) where b.data is distinct from to_jsonb(s)) then raise exception 'Existing spare changed'; end if;
end $check$;
set local role anon;
do $deny$ begin
 begin
  perform app.prepare_yahoo_auction_item(null);
  raise exception 'Anonymous RPC allowed';
 exception when insufficient_privilege then null;
 end;
end $deny$;
reset role;
select 'suffix separation, correct remote, mismatched move rejection, idempotency, fallback, original data unchanged, anonymous denial: passed' as result;
rollback;
