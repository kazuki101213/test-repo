begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,sold_on,sold_price,payout_amount,seller_trade_key)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),'2026-10-01','completed trade test',100,'メルカリ','メルカリ','2026-10-02',1000,900,'m'||n||':2026-10-02'
from generate_series(998510,998513) n;
insert into app.delivery_shipping_tasks(item_id,created_at)
select id,clock_timestamp()-interval '2 days' from app.items where lot_seq between 998510 and 998513;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key,observed_at,observed_status,verified_sale,active)
select id,'メルカリ','mercari-2','m'||lot_seq,'https://jp.mercari.com/item/m'||lot_seq,
 case when lot_seq=998511 then 'old-trade' else seller_trade_key end,clock_timestamp(),'販売済',
 case when lot_seq=998512 then null else jsonb_build_object('sold_on',sold_on,'sold_price',sold_price,'payout_amount',payout_amount) end,lot_seq<>998513
from app.items where lot_seq between 998510 and 998513;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare i app.items;begin
 select * into i from app.items where lot_seq=998510;
 if not app.current_trade_completed(i.id) then raise exception 'Matching completed current trade lost';end if;
 if exists(select 1 from app.delivery_shipping_tasks where item_id=i.id and resolved_at is null) then raise exception 'Completed shipping task remains';end if;
 if i.shipped_on is not null then raise exception 'Shipping date was guessed';end if;
 if exists(select 1 from jsonb_array_elements(app.read_resource_snapshot('admin_shipping_tasks')->'rows') r where r->>'item_id'=i.id::text) then raise exception 'Completed task visible';end if;
 for i in select * from app.items where lot_seq between 998511 and 998513 loop
  if app.current_trade_completed(i.id) then raise exception 'Old, inactive or missing proof accepted: %',i.lot_seq;end if;
  if not exists(select 1 from app.delivery_shipping_tasks where item_id=i.id and resolved_at is null) then raise exception 'Unconfirmed task removed: %',i.lot_seq;end if;
 end loop;
 if has_function_privilege('anon','app.current_trade_completed(uuid)','execute') then raise exception 'Anonymous proof access';end if;
 if (select prosecdef from pg_proc where oid='app.current_trade_completed(uuid)'::regprocedure) then raise exception 'Proof bypasses RLS';end if;
end $$;
rollback;
