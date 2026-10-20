begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,returned_on,status)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'Return duration fixture',1000,'メルカリ','メルカリ','fixture',now(),case when n=998451 then current_date else null end,case when n=998451 then '返品処理'::app.item_status else '商品登録前'::app.item_status end from generate_series(998451,998452) n;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin
 if not exists(select 1 from app.v_items where lot_seq=998451 and status='返品処理' and days_to_sell is null and days_in_stock is null) then raise exception 'Return still has selling duration';end if;
 if not exists(select 1 from app.v_inventory_display where lot_seq=998451 and days_to_sell is null and days_in_stock is null) then raise exception 'Display snapshot retains return duration';end if;
 if not exists(select 1 from app.v_items where lot_seq=998452 and days_in_stock=10) then raise exception 'Non-return duration changed';end if;
end $$;
rollback;
