begin;
do $test$
declare buyer uuid; worker uuid; body uuid; doc jsonb; v bigint;
begin
 select id into buyer from app.staff where code='AA';
 select id into worker from app.staff where code='DD';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.delivery_invoice_profiles(staff_id,details,unit_price,enabled)
 values(worker,'{}',1001,true) on conflict(staff_id) do update set unit_price=1001,enabled=true;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,packed_on)
 values('899993-AADD-20260101-100',899993,'invoice origin',1000,'ヤフオク','2026-01-01',buyer,worker,'FBA','2026-10-01') returning id into body;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,packed_on)
 values('899993a-AADD-20261002-0',899993,'invoice a',0,'Amazon返品','2026-10-02',buyer,worker,'FBA','2026-11-01'),
 ('899993b-AADD-20261003-0',899993,'invoice b',0,'動作品Amazon返品','2026-10-03',buyer,worker,'FBA','2026-11-02'),
 ('899993bb-AADD-20261004-0',899993,'invoice bb',0,'動作品Amazon返品','2026-10-04',buyer,worker,'FBA','2026-12-01');
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,packed_on,is_accessory,parent_item_id)
 values('899993-AADD-20260101-10',899993,'attached remote',100,'ヤフオク','2026-01-01',buyer,worker,'FBA','2026-10-01',true,body),
 ('899993c-AADD-20261004-20',899993,'invoice C',200,'ヤフオク','2026-10-04',buyer,worker,'FBA','2026-11-03',true,body);
 doc:=app.prepare_delivery_invoice(worker,'2026-11-01');
 select count(*) into v from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer=899993;
 if v<>3 then raise exception 'A/B/C invoice count wrong: %',v; end if;
 select sum((x->>'amount')::bigint) into v from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer=899993;
 if v<>2001 then raise exception 'A full + B/C half subtotal wrong: %',v; end if;
 if not exists(select 1 from jsonb_array_elements(doc->'lines') x where lower(x->>'serial')='899993b' and x->>'description'='動作品Amazon返品対応' and (x->>'unit_price')::bigint=500)
 then raise exception 'B not half price';end if;
 doc:=app.prepare_delivery_invoice(worker,'2026-10-01');
 select count(*) into v from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer=899993;
 if v<>1 then raise exception 'Attached accessory was counted';end if;
 doc:=app.prepare_delivery_invoice(worker,'2026-12-01');
 select sum((x->>'amount')::bigint) into v from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer=899993;
 if v<>500 then raise exception 'Repeated BB stage not charged separately at half price';end if;
end $test$;
rollback;
