begin;
do $test$
declare primary_id uuid; accessory_id uuid; v bigint; test_purchaser uuid; test_deliverer uuid;
begin
 select id into test_purchaser from app.staff where code='AA';
 select id into test_deliverer from app.staff where code='DD';
 if app.financial_product_serial('899991a-AAII-20260101-0',899991)<>'899991'
 or app.financial_product_serial('899991bbb-AAII-20260101-0',899991)<>'899991'
 or app.financial_product_serial('899991c-AAII-20260101-0',899991)<>'899991c'
 or app.financial_product_serial('899991z-AAII-20260101-0',899991)<>'899991z' then raise exception 'Family key isolation failed'; end if;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('899991-AAII-20260101-1000',899991,'accounting test origin',10000,'ヤフオク','2026-01-01','2026-10-01',0,0,test_purchaser,test_deliverer,'メルカリ') returning id into primary_id;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,is_accessory,parent_item_id,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('899991-AAII-20260101-100',899991,'accounting test accessory',1000,'ヤフオク','2026-01-01',true,primary_id,'2026-10-01',0,0,test_purchaser,test_deliverer,'メルカリ');
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('899991b-AAII-20261002-0',899991,'accounting test return',0,'動作品Amazon返品','2026-10-02','2026-10-03',20000,18000,test_purchaser,test_deliverer,'メルカリ');
 select count(*) into v from app.v_financial_sales where family_key='899991';
 if v<>1 then raise exception 'Zero closure counted as sale'; end if;
 select cost_amount into v from app.v_financial_sales where family_key='899991';
 if v<>11000 then raise exception 'Original and accessory cost not carried: %',v; end if;
 select profit into v from app.v_financial_sales where family_key='899991';
 if v<>7000 then raise exception 'First resale profit incorrect: %',v; end if;
 update app.items set amazon_refund_amount=-18000 where lot_seq=899991 and lower(app.product_serial(sku,lot_seq))='899991b';
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('899991aa-AAII-20261004-0',899991,'accounting test second return',0,'Amazon返品','2026-10-04','2026-10-05',25000,22500,test_purchaser,test_deliverer,'メルカリ');
 select sum(cost_amount) into v from app.v_financial_sales where family_key='899991';
 if v<>11000 then raise exception 'Purchase cost charged twice: %',v; end if;
 select sum(profit) into v from app.v_financial_sales where family_key='899991';
 if v<>11500 then raise exception 'Refund and resale total incorrect: %',v; end if;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,is_accessory,parent_item_id,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('899991c-AAII-20260101-200',899991,'accounting test standalone accessory',2000,'ヤフオク','2026-01-01',true,primary_id,'2026-10-06',4000,3500,test_purchaser,test_deliverer,'メルカリ');
 select profit into v from app.v_financial_sales where family_key='899991c';
 if v<>1500 then raise exception 'Standalone C sale merged into body'; end if;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('899992-AAII-20260101-50',899992,'accounting test genuine zero sale',500,'ヤフオク','2026-01-01','2026-10-01',0,0,test_purchaser,test_deliverer,'メルカリ');
 select profit into v from app.v_financial_sales where family_key='899992';
 if v<>-500 then raise exception 'Genuine zero sale disappeared'; end if;
end $test$;

rollback;
