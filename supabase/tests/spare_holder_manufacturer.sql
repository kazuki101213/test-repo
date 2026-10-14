begin;
do $test$
declare buyer uuid; worker uuid; remote_buyer uuid; body uuid; spare uuid; sharp uuid; sony uuid; maker text; holder uuid;
begin
 select id into buyer from app.staff where code='AA';
 select id into remote_buyer from app.staff where code='EE';
 select id into worker from app.staff where code='MM';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.products(product_no,asin,model_no,maker) values(899994,'B00SPARE01','SPARE-SHARP','SHARP') returning id into sharp;
 insert into app.products(product_no,asin,model_no,maker) values(899995,'B00SPARE02','SPARE-SONY','SONY') returning id into sony;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,product_id)
 values('899994-AAMM-20260101-100',899994,'spare source body',1000,'ヤフオク','2026-01-01',buyer,worker,'FBA',sharp) returning id into body;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,is_accessory,parent_item_id)
 values('899994-EEMM-20260101-50',899994,'リモコン',500,'ヤフオク','2026-01-01',remote_buyer,worker,'FBA',true,body);
 perform app.prepare_yahoo_auction_item(body);
 select id,manufacturer,owner_staff_id into spare,maker,holder from app.spare_accessories where usage_note='899994';
 if maker is distinct from 'SHARP' or holder is distinct from worker then
  raise exception 'Missing remote product must inherit body maker and delivery holder: %, %',maker,holder;end if;
 if not exists(select 1 from app.spare_accessories where id=spare and source_sku like '899994-EEMM-%' and cost_amount=500) then
  raise exception 'Historical remote purchase reference changed';end if;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,product_id)
 values('899994a-AAMM-20261002-0',899994,'spare suffix body',0,'Amazon返品','2026-10-02',buyer,worker,'FBA',sony);
 insert into app.spare_accessories(title,usage_note,owner_staff_id) values('リモコン','899994a',worker) returning manufacturer into maker;
 if maker is distinct from 'SONY' then raise exception 'Spare body lookup mixed suffixes: %',maker;end if;
 insert into app.spare_accessories(title,usage_note,owner_staff_id,manufacturer)
 values('互換リモコン','899994a',worker,'Explicit maker') returning manufacturer into maker;
 if maker is distinct from 'Explicit maker' then raise exception 'Explicit remote maker overwritten';end if;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,product_id)
 values('899996-AAMM-20260101-100',899996,'spare body without remote',1000,'ヤフオク','2026-01-01',buyer,worker,'FBA',sony) returning id into body;
 perform app.prepare_yahoo_auction_item(body);
 select manufacturer,owner_staff_id into maker,holder from app.spare_accessories where usage_note='899996';
 if maker is distinct from 'SONY' or holder is distinct from worker then raise exception 'Body-only spare holder/maker wrong';end if;
end $test$;
rollback;
