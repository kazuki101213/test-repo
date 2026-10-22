begin;
-- Represent legacy conflicting sale rows; production guards remain unchanged.
alter table app.items disable trigger items_single_product_sale;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $$
declare buyer uuid; worker uuid; result jsonb;
begin
 select id into buyer from app.staff where code='AA';select id into worker from app.staff where code='DD';
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('997900-AADD-20980101-100',997900,'chart origin',1000,'ヤフオク','2098-01-01','2099-01-01',1000,900,buyer,worker,'メルカリ'),
 ('997900a-AADD-20980102-0',997900,'chart resale',0,'動作品Amazon返品','2098-01-02','2099-01-01',2000,1800,buyer,worker,'メルカリ'),
 ('997900b-AADD-20980103-0',997900,'chart second date',0,'動作品Amazon返品','2098-01-03','2099-01-02',3000,2700,buyer,worker,'メルカリ'),
 ('997901-AADD-20980101-1',997901,'chart conflict',10,'ヤフオク','2098-01-01','2099-01-02',500,400,buyer,worker,'メルカリ'),
 ('997901-AADD-20980102-2',997901,'chart conflict outside range',20,'ヤフオク','2098-01-02','2099-02-01',600,500,buyer,worker,'メルカリ'),
 ('997902-AADD-20980101-0',997902,'chart unknown price',0,'ヤフオク','2098-01-01','2099-01-01',null,null,buyer,worker,'メルカリ');
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel,is_accessory)
 values('997900c-AADD-20980101-0',997900,'chart independent zero accessory',0,'ヤフオク','2098-01-01','2099-01-01',0,0,buyer,worker,'メルカリ',true);
 result:=app.read_daily_sales_summary('2099-01-01','2099-01-03');
 if result->'days' is distinct from '[{"date":"2099-01-01","amount":3000,"count":2},{"date":"2099-01-02","amount":3000,"count":1},{"date":"2099-01-03","amount":0,"count":0}]'::jsonb then raise exception 'Daily family aggregation differs: %',result;end if;
 if result->'conflicts' is distinct from '["997901","997902"]'::jsonb then raise exception 'Conflicts/unknown price lost: %',result;end if;
 begin perform app.read_daily_sales_summary('2099-02-01','2099-01-01');raise exception 'Invalid range accepted';exception when invalid_parameter_value then null;end;
 begin perform app.read_daily_sales_summary(null,'2099-01-01');raise exception 'Empty date accepted';exception when invalid_parameter_value then null;end;
 if (select prosecdef from pg_proc where oid='app.read_daily_sales_summary(date,date)'::regprocedure) then raise exception 'Aggregation must respect caller RLS';end if;
 if has_function_privilege('anon','app.read_daily_sales_summary(date,date)','execute') then raise exception 'Anonymous aggregation access';end if;
end $$;
reset role;
alter table app.items enable trigger items_single_product_sale;
set local role authenticated;
-- Deliverer sees no other staff's financial rows through the aggregation.
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 if exists(select 1 from jsonb_array_elements(app.read_daily_sales_summary('2099-01-01','2099-01-03')->'days') d where (d->>'amount')::bigint<>0) then raise exception 'Aggregation bypassed caller row access';end if;
end $$;
rollback;
