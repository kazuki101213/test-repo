begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status,shipped_on)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'legacy trade shipping fixture',1000,'ヤフオク','メルカリ','fixture',now(),now(),'出品中',current_date-7
 from generate_series(998671,998676) n;

-- Simulate trades imported before the original date safeguard was installed.
alter table app.items disable trigger items_clear_prior_trade_shipping_date;
update app.items set status='取引中',seller_trade_key='m'||lot_seq||':'||to_char(current_date-1,'YYYY-MM-DD')||'T12:00'
 where lot_seq between 998671 and 998676;
alter table app.items enable trigger items_clear_prior_trade_shipping_date;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key,observed_status,active)
 select id,sales_channel,'mercari-2','m'||lot_seq,'https://jp.mercari.com/item/m'||lot_seq,seller_trade_key,'取引中',lot_seq<>998676
 from app.items where lot_seq between 998671 and 998676;
update app.items set shipped_on=current_date-1 where lot_seq=998672;
update app.items set seller_trade_key='m998673:unknown' where lot_seq=998673;
update app.seller_listings set trade_key='m998673:unknown' where external_id='m998673';
update app.items set sold_on=current_date,sold_price=2000,payout_amount=1800 where lot_seq=998674;
update app.seller_listings set observed_status='販売済' where external_id='m998674';
update app.items set shipped_on=null where lot_seq=998675;
delete from app.delivery_push_events where item_id=(select id from app.items where lot_seq=998675);
delete from app.delivery_shipping_tasks where item_id=(select id from app.items where lot_seq=998675);

\ir ../migrations/20261021132239_reconcile_existing_shipping_requests.sql

do $$begin
 if exists(select 1 from app.items where lot_seq in(998671,998675) and shipped_on is not null) then raise exception 'Legacy date not cleared';end if;
 if (select count(*) from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq in(998671,998675) and t.resolved_at is null)<>2 then raise exception 'Existing trades not reconciled';end if;
 if (select count(*) from app.delivery_push_events e join app.items i on i.id=e.item_id where i.lot_seq in(998671,998675) and e.kind='shipping')<>2 then raise exception 'Shipping push missing';end if;
 if not exists(select 1 from app.items where lot_seq=998672 and shipped_on=current_date-1) then raise exception 'Same-day shipment cleared';end if;
 if (select count(*) from app.items where lot_seq in(998673,998674,998676) and shipped_on=current_date-7)<>3 then raise exception 'Unknown/completed/inactive history changed';end if;
 if exists(select 1 from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq in(998672,998673,998674,998676) and t.resolved_at is null) then raise exception 'Unrelated shipping request created';end if;
 if not exists(select 1 from app.audit_log a join app.items i on i.id=a.row_id where i.lot_seq=998671 and a.old_data->>'shipped_on'=to_char(current_date-7,'YYYY-MM-DD') and a.new_data->>'shipped_on' is null) then raise exception 'Legacy date audit missing';end if;
end $$;

-- Reapplying the repair and subsequent identical observations never duplicate it.
\ir ../migrations/20261021132239_reconcile_existing_shipping_requests.sql
update app.items set status=status where lot_seq in(998671,998675);
do $$begin
 if (select count(*) from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq in(998671,998675))<>2 then raise exception 'Repeated reconciliation duplicated request';end if;
 if (select count(*) from app.delivery_push_events e join app.items i on i.id=e.item_id where i.lot_seq in(998671,998675) and e.kind='shipping')<>2 then raise exception 'Repeated reconciliation duplicated push';end if;
end $$;
-- An import/edit of just shipped_on cannot reintroduce a pre-purchase date.
update app.items set shipped_on=current_date-7 where lot_seq=998672;
do $$begin
 if not exists(select 1 from app.items where lot_seq=998672 and shipped_on is null) then raise exception 'Shipping-only edit bypassed safeguard';end if;
 if not exists(select 1 from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq=998672 and t.resolved_at is null) then raise exception 'Shipping-only correction omitted request';end if;
end $$;
rollback;
