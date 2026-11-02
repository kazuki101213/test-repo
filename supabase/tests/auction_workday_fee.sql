begin;
do $test$
declare owner uuid; worker uuid; login text; inv app.delivery_invoices; result jsonb; bad jsonb; rejected boolean;
begin
 select id into owner from app.staff where code='AA';
 select id into worker from app.staff where code='DD';
 select user_id::text into login from app.profiles where staff_id=owner limit 1;
 perform set_config('request.jwt.claim.sub',login,true);
 insert into app.delivery_invoice_profiles(staff_id,details,enabled,unit_price,tax_percent)
 values(owner,'{"issuer_name":"石川秀樹"}',true,500,0)
 on conflict(staff_id) do update set details=excluded.details,enabled=true,unit_price=500,tax_percent=0;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,sold_on,sold_price,payout_amount,purchaser_id,deliverer_id,sales_channel)
 values('997990-AADD-20990601-0',997990,'auction fee regression',0,'ヤフオク','2099-06-01','2099-06-02',100000,100000,owner,worker,'メルカリ');
 execute 'set local role authenticated';
 result:=app.submit_invoice_documents(owner,'2099-06-01',true,false,'2099-07-01',
  '[{"date":"2099-06-01","description":"ヤフオク入札作業日","quantity":1,"unit_price":3000},{"date":"2099-06-03","description":"ヤフオク入札作業日","quantity":1,"unit_price":2000}]','料金検証',null);
 select * into inv from app.delivery_invoices where id=(result->'invoice'->>'id')::uuid;
 if inv.total<>10000 or inv.extras->0->>'unit_price'<>'3000' or inv.extras->0->>'amount'<>'3000'
  or inv.extras->2->>'unit_price'<>'5000' or inv.snapshot->'extras' is distinct from inv.extras then
  raise exception 'Per-day rates / real gross-profit adjustment were not preserved: %',inv.extras;
 end if;
 result:=app.submit_invoice_documents(owner,'2099-06-01',true,false,'2099-07-01',
  '[{"date":"2099-06-01","description":"ヤフオク入札作業日","quantity":1,"unit_price":9000},{"date":"2099-06-03","description":"ヤフオク入札作業日","quantity":1,"unit_price":2000}]','変更',inv.version);
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>11000 or jsonb_array_length(inv.extras)<>2 or inv.extras->0->>'unit_price'<>'9000' then
  raise exception 'Reloaded fee or recalculated adjustment differs';
 end if;
 for bad in select value from jsonb_array_elements('[
  [{"date":"2099-06-01","quantity":1,"unit_price":-1}],
  [{"date":"2099-06-01","quantity":1,"unit_price":1.5}],
  [{"date":"2099-06-01","quantity":1,"unit_price":10000001}],
  [{"date":"2099-05-31","quantity":1,"unit_price":500}],
  [{"date":null,"quantity":1,"unit_price":500}],
  [{"date":"2099-06-01","quantity":2,"unit_price":500}],
  [{"date":"2099-06-01","quantity":1,"unit_price":500},{"date":"2099-06-01","quantity":1,"unit_price":500}]
 ]'::jsonb) loop
  select jsonb_agg(x||'{"description":"ヤフオク入札作業日"}'::jsonb) into bad from jsonb_array_elements(bad) x;
  rejected:=false;
  begin
   perform app.submit_invoice_documents(owner,'2099-06-01',true,false,'2099-07-01',bad,'不正料金',inv.version);
  exception when others then rejected:=true; end;
  if not rejected then raise exception 'Invalid workday was accepted: %',bad; end if;
 end loop;
 result:=app.submit_invoice_documents(owner,'2099-06-01',true,false,'2099-07-01',
  '[{"date":"2099-06-03","description":"ヤフオク入札作業日","quantity":1,"unit_price":0}]','削除と0円',inv.version);
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>10000 or inv.extras->0->>'unit_price'<>'0' or inv.extras->0->>'date'<>'2099-06-03' then
  raise exception 'Zero rate or day removal lost';
 end if;
 execute 'reset role';
end $test$;
rollback;
