begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status,shipped_on)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'trade shipping fixture',1000,'ヤフオク','メルカリ','fixture',now(),now(),'出品中',current_date-7
 from generate_series(998661,998663) n;
create temporary table trade_shipping_probe as select id,lot_seq from app.items where lot_seq between 998661 and 998663;
grant select on trade_shipping_probe to authenticated;

set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare v_id uuid:=(select id from trade_shipping_probe where lot_seq=998661);result text;begin
 result:=app.sync_seller_observation('mercari-2',jsonb_build_object('serial','998661','external_id','m998661','status','取引中','trade_key','m998661:'||to_char(current_date-1,'YYYY-MM-DD')||'T13:35','observed_at',clock_timestamp()));
 if result<>'updated' then raise exception 'Trade sync failed: %',result;end if;
 if not exists(select 1 from app.items where id=v_id and shipped_on=current_date-7 and status='取引中') then raise exception 'Observation erased shipping date without confirmation';end if;
 if exists(select 1 from app.delivery_shipping_tasks where item_id=v_id and resolved_at is null) then raise exception 'Old date inferred an unshipped request';end if;
end $$;
set local role postgres;
-- Only an explicit shipping-date correction can restore an unshipped request.
update app.items set shipped_on=null where id=(select id from trade_shipping_probe where lot_seq=998661);
update app.items set status='取引中',seller_trade_key='m998662:'||to_char(current_date-7,'YYYY-MM-DD')||'T12:00' where id=(select id from trade_shipping_probe where lot_seq=998662);
update app.items set status='取引中',seller_trade_key='m998663:unknown' where id=(select id from trade_shipping_probe where lot_seq=998663);
do $$begin
 if exists(select 1 from app.items where lot_seq in(998662,998663) and shipped_on is distinct from current_date-7) then raise exception 'Current or undated shipping history was cleared';end if;
end $$;
update app.items set status=status where id=(select id from trade_shipping_probe where lot_seq=998661);
do $$begin
 if (select count(*) from app.delivery_shipping_tasks where item_id=(select id from trade_shipping_probe where lot_seq=998661))<>1 then raise exception 'Repeated observation duplicated request';end if;
end $$;
update app.items set shipped_on=current_date where id=(select id from trade_shipping_probe where lot_seq=998661);
do $$begin
 if exists(select 1 from app.delivery_shipping_tasks where item_id=(select id from trade_shipping_probe where lot_seq=998661) and resolved_at is null) then raise exception 'Actual shipment did not close request';end if;
end $$;
-- Removing a mistaken current shipment while already trading recreates one card.
update app.items set shipped_on=null where id=(select id from trade_shipping_probe where lot_seq=998661);
do $$begin
 if (select count(*) from app.delivery_shipping_tasks where item_id=(select id from trade_shipping_probe where lot_seq=998661) and resolved_at is null)<>1 then raise exception 'Correcting shipment did not restore request';end if;
end $$;
rollback;
