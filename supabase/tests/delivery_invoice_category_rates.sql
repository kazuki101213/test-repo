begin;
do $test$
declare
 buyer uuid; koel uuid; yoshimitsu uuid; doc jsonb; prices bigint[];
 koel_rates constant jsonb := '{"from_month":"2026-11-01","monitor":450,"bluray":500}';
 yoshimitsu_rates constant jsonb := '{"from_month":"2026-11-01","monitor":450,"bluray":500,"trial":400}';
begin
 select id into buyer from app.staff where code='AA';
 select id into koel from app.staff where code='KK';
 select id into yoshimitsu from app.staff where code='MM';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 if has_column_privilege('authenticated','app.delivery_invoice_profiles','category_rates','UPDATE') then
  raise exception 'Category rates must be read-only to authenticated users';
 end if;
 insert into app.delivery_invoice_profiles(staff_id,details,unit_price,enabled,category_rates)
 values (koel,'{}',400,true,koel_rates), (yoshimitsu,'{}',500,true,yoshimitsu_rates)
 on conflict(staff_id) do update set enabled=true,unit_price=excluded.unit_price,category_rates=excluded.category_rates;
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,packed_on,work_stream)
 values
  ('899981-AAKK-20260101-100',899981,'monitor',1000,'ヤフオク','2026-01-01',buyer,koel,'FBA','2026-11-01','テレビ'),
  ('899982-AAKK-20260101-100',899982,'bluray',1000,'ヤフオク','2026-01-01',buyer,koel,'FBA','2026-11-01','ブルーレイ'),
  ('899983-AAKK-20260101-100',899983,'small',1000,'ヤフオク','2026-01-01',buyer,koel,'FBA','2026-11-01','その他'),
  ('899984b-AAKK-20260101-100',899984,'monitor return',1000,'動作品Amazon返品','2026-01-01',buyer,koel,'FBA','2026-11-01','テレビ'),
  ('899985-AAMM-20260101-100',899985,'trial monitor',1000,'ヤフオク','2026-01-01',buyer,yoshimitsu,'FBA','2026-11-01','テレビ'),
  ('899986-AAMM-20260101-100',899986,'trial bluray',1000,'ヤフオク','2026-01-01',buyer,yoshimitsu,'FBA','2026-11-01','ブルーレイ'),
  ('899987-AAMM-20260101-100',899987,'prior monitor',1000,'ヤフオク','2026-01-01',buyer,yoshimitsu,'FBA','2026-10-01','テレビ'),
  ('899988-AAMM-20260101-100',899988,'normal monitor',1000,'ヤフオク','2026-01-01',buyer,yoshimitsu,'FBA','2026-12-01','テレビ'),
  ('899989-AAMM-20260101-100',899989,'normal bluray',1000,'ヤフオク','2026-01-01',buyer,yoshimitsu,'FBA','2026-12-01','ブルーレイ');
 doc:=app.prepare_delivery_invoice(koel,'2026-11-01');
 select array_agg((x->>'unit_price')::bigint order by (x->>'lot_seq')::integer) into prices
 from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer between 899981 and 899984;
 if prices is distinct from array[450,500,400,225]::bigint[] then raise exception 'Incorrect Koel rates: %',prices; end if;

 doc:=app.prepare_delivery_invoice(yoshimitsu,'2026-10-01');
 if doc->'lines'->0->>'unit_price' is distinct from '500' then raise exception 'Historical rate changed'; end if;

 update app.delivery_invoice_profiles set category_rates = category_rates || '{"trial_until":"2026-12-01"}'::jsonb
 where staff_id=yoshimitsu;
 doc:=app.prepare_delivery_invoice(yoshimitsu,'2026-11-01');
 select array_agg((x->>'unit_price')::bigint order by (x->>'lot_seq')::integer) into prices
 from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer between 899985 and 899986;
 if prices is distinct from array[400,400]::bigint[] then raise exception 'Incorrect trial rates: %',prices; end if;

 doc:=app.prepare_delivery_invoice(yoshimitsu,'2026-12-01');
 select array_agg((x->>'unit_price')::bigint order by (x->>'lot_seq')::integer) into prices
 from jsonb_array_elements(doc->'lines') x where (x->>'lot_seq')::integer between 899988 and 899989;
 if prices is distinct from array[450,500]::bigint[] then raise exception 'Incorrect post-trial rates: %',prices; end if;
end $test$;
rollback;
