-- Transactional verification only. All fixture rows are rolled back.
begin;
insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sales_channel,is_accessory)
values('999999997-AA-20260901-100',999999997,'verification-only',1000,'その他','2026-09-01','FBA',false),
('999999997-AA-20260902-20',999999997,'verification-only-accessory',200,'その他','2026-09-02','FBA',true);
insert into app.amazon_payment_transactions(account_key,marketplace_id,transaction_id,posted_at,transaction_type,status,item_breakdowns,fetched_at)
values('verification-only','A1VC38T7YXB528','verify-lot-sale',now(),'Shipment','RELEASED','[{"sku":"999999997-AA-20260903-100","currency":"JPY","quantity":1,"amount":1700}]',now()),
('verification-only','A1VC38T7YXB528','verify-lot-sibling',now(),'Shipment','RELEASED','[{"sku":"999999997-AA-20260902-20","currency":"JPY","quantity":1,"amount":1700}]',now());
set local role service_role;
do $$ declare result jsonb; actor uuid; blocked boolean:=false;
begin
select p.user_id into actor from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active limit 1;
result := app.apply_amazon_sale('verification-only','verify-lot-sale','999999997-AA-20260903-100',null,'2026-09-25',2000,1700,actor);
if result->>'status'<>'applied' then raise exception 'lot fallback failed: %',result; end if;
result := app.apply_amazon_sale('verification-only','verify-lot-sale','999999997-AA-20260903-100',null,'2026-09-25',2000,1700,actor);
if result->>'status'<>'unchanged' then raise exception 'idempotency failed'; end if;
result := app.apply_amazon_sale('verification-only','verify-lot-sibling','999999997-AA-20260902-20',null,'2026-09-25',2000,1700,actor);
if result->>'status'<>'unchanged' then raise exception 'sibling dedup failed: %',result; end if;
begin
update app.items set sold_on='2026-09-25',sold_price=2000,payout_amount=1700 where sku='999999997-AA-20260902-20';
exception when raise_exception then blocked:=position('重複登録' in SQLERRM)>0;
end;
if not blocked then raise exception 'duplicate sale was not blocked'; end if;
if (select product_cost from app.v_product_groups where lot_seq=999999997)<>1200 then raise exception 'cost mismatch'; end if;
if (select product_sold_price from app.v_product_groups where lot_seq=999999997)<>2000 then raise exception 'shared sale mismatch'; end if;
if (select count(*) from app.items where lot_seq=999999997)<>2 then raise exception 'purchase rows lost'; end if;
end $$;
rollback;
