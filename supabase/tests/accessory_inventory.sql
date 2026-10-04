-- Each supplier row remains independent; only work and sale fields are shared.
begin;
insert into app.items (sku,lot_seq,title,cost_amount,marketplace,purchased_at,is_accessory,condition,sales_channel,planned_price,planned_payout)
values
 ('999999991-AA-20260901-100',999999991,'main',1000,'その他','2026-09-01',false,'良い','FBA',3000,2500),
 ('999999991-AA-20260902-20',999999991,'remote',200,'その他','2026-09-02',true,null,null,null,null),
 ('999999991a-AA-20260903-100',999999991,'return',1000,'その他','2026-09-03',false,'可','自己発送',4000,3500),
 ('999999991a-AA-20260904-20',999999991,'return remote',200,'その他','2026-09-04',true,null,null,null,null);

do $$ declare accessory app.items; begin
 select * into accessory from app.items where sku='999999991-AA-20260902-20';
 if accessory.condition <> '良い' or accessory.sales_channel <> 'FBA'
    or accessory.planned_price <> 3000 or accessory.planned_payout <> 2500 then
   raise exception 'new accessory did not inherit sale plan';
 end if;
 if accessory.title <> 'remote' or accessory.cost_amount <> 200 or accessory.purchased_at <> '2026-09-02' then
   raise exception 'accessory purchase details changed';
 end if;
end $$;

update app.items set packed_on='2026-09-10',shipped_on='2026-09-11',inspected_at='2026-09-09T00:00:00Z'
where sku='999999991-AA-20260901-100';
do $$ declare accessory app.items; begin
 select * into accessory from app.items where sku='999999991-AA-20260902-20';
 if accessory.status <> '出品中' or accessory.packed_on <> '2026-09-10'
    or accessory.shipped_on <> '2026-09-11' or accessory.inspected_at is null then
   raise exception 'main work progress did not propagate';
 end if;
 if (select shipped_on from app.items where sku='999999991a-AA-20260904-20') is not null then
   raise exception 'return suffix crossed product boundary';
 end if;
end $$;

-- Clearing work dates and holding the main item must also reach the accessory.
update app.items set packed_on=null,shipped_on=null,status='保留'
where sku='999999991-AA-20260901-100';
do $$ begin
 if not exists(select 1 from app.items where sku='999999991-AA-20260902-20'
   and packed_on is null and shipped_on is null and status='保留') then
   raise exception 'cleared work state did not propagate';
 end if;
end $$;

update app.items set sold_on='2026-09-20',sold_price=3000,payout_amount=2500,status='販売済'
where sku='999999991-AA-20260901-100';
insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,is_accessory)
values('999999991-AA-20260905-30',999999991,'late cable',300,'その他','2026-09-05',true);
do $$ begin
 if (select count(*) from app.items where lot_seq=999999991 and is_accessory
     and app.product_serial(sku,lot_seq)='999999991' and status='販売済'
     and sold_on='2026-09-20' and sold_price is null and payout_amount is null) <> 2 then
   raise exception 'sale state or late accessory inheritance failed';
 end if;
 if not exists(select 1 from app.v_product_groups where serial_key='999999991'
     and sale_row_count=1 and product_sold_price=3000 and product_payout_amount=2500 and product_cost=1500) then
   raise exception 'sale counted twice or purchase cost lost';
 end if;
 if (select count(*) from app.v_inventory_display where lot_seq=999999991) <> 5 then
   raise exception 'independent inventory rows were lost';
 end if;
end $$;

-- Accessory purchase edits must not diverge from the main work/sale state.
update app.items set title='edited remote',cost_amount=250,status='廃棄',sold_on=null
where sku='999999991-AA-20260902-20';
do $$ begin
 if not exists(select 1 from app.items where lot_seq=999999991 and is_accessory
     and app.product_serial(sku,lot_seq)='999999991'
     and title='edited remote' and cost_amount=250 and status='販売済' and sold_on='2026-09-20') then
   raise exception 'accessory edit diverged or lost its purchase fields';
 end if;
end $$;

-- Clearing a sale is shared without deleting supplier history.
update app.items set sold_on=null,sold_price=null,payout_amount=null,status='作業中'
where sku='999999991-AA-20260901-100';
do $$ begin
 if exists(select 1 from app.items where lot_seq=999999991 and is_accessory
     and app.product_serial(sku,lot_seq)='999999991' and (sold_on is not null or status <> '作業中')) then
   raise exception 'sale clear did not propagate';
 end if;
end $$;
rollback;
\echo '本体・付属品の作業状態・販売情報の連動: 成功'
