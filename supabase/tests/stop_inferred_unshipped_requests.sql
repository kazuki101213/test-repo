begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,product_registered_at,status,shipped_on)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'shipping evidence fixture',1000,'ヤフオク','メルカリ','fixture',now(),now(),'出品中',current_date-7
 from generate_series(998671,998673) n;
-- Entering a purchased trade does not prove that an old shipment did not happen.
update app.items set status='取引中',seller_trade_key='m'||lot_seq||':'||to_char(current_date-1,'YYYY-MM-DD')||'T12:00'
 where lot_seq between 998671 and 998673;
update app.items set shipped_on=current_date-8 where lot_seq=998672;
update app.items set status=status where lot_seq between 998671 and 998673;
do $$begin
 if (select count(*) from app.items where lot_seq in(998671,998673) and shipped_on=current_date-7)<>2 then raise exception 'Old shipment was inferred unshipped';end if;
 if not exists(select 1 from app.items where lot_seq=998672 and shipped_on=current_date-8) then raise exception 'Explicit date edit was erased';end if;
 if exists(select 1 from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq between 998671 and 998673) then raise exception 'Date inconsistency created shipping request';end if;
 if exists(select 1 from app.delivery_push_events e join app.items i on i.id=e.item_id where i.lot_seq between 998671 and 998673 and e.kind='shipping') then raise exception 'Date inconsistency sent shipping push';end if;
end $$;
-- Explicitly clearing a date still restores the ordinary shipping workflow.
update app.items set shipped_on=null where lot_seq=998671;
update app.items set status=status where lot_seq=998671;
do $$begin
 if (select count(*) from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq=998671 and t.resolved_at is null)<>1 then raise exception 'Explicit correction did not restore one request';end if;
 if (select count(*) from app.delivery_push_events e join app.items i on i.id=e.item_id join app.staff s on s.id=e.staff_id where i.lot_seq=998671 and e.kind='shipping' and s.code='DD')<>1 then raise exception 'Explicit correction push missing or duplicated';end if;
end $$;
update app.items set shipped_on=current_date where lot_seq=998671;
do $$begin
 if exists(select 1 from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where i.lot_seq=998671 and t.resolved_at is null) then raise exception 'Shipment failed to resolve request';end if;
end $$;
rollback;
