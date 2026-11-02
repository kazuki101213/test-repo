begin;
do $test$
declare worker uuid; admin_login text; worker_login text; receipt uuid:=gen_random_uuid(); inv app.delivery_invoices;
 result jsonb; failed boolean; expense uuid;
begin
 select id into worker from app.staff where code='DD';
 select user_id::text into admin_login from app.profiles where staff_id=(select id from app.staff where code='AA') limit 1;
 select user_id::text into worker_login from app.profiles where staff_id=worker limit 1;
 perform set_config('request.jwt.claim.sub',admin_login,true);
 insert into app.delivery_invoice_profiles(staff_id,details,enabled,unit_price,tax_percent)
 values(worker,'{"issuer_name":"共通入力検証"}',true,500,0)
 on conflict(staff_id) do update set details=excluded.details,enabled=true,unit_price=500,tax_percent=0;
 insert into app.invoice_receipts(id,staff_id,billing_month,storage_path,original_name,spent_on,description,amount,include_in_invoice)
 values(receipt,worker,'2099-05-01',worker::text||'/2099-05/'||receipt::text||'.jpg','receipt.jpg','2099-05-01','資材',600,true);
 execute 'set local role authenticated';
 -- Management and delivery now call exactly the same submission function.
 result:=app.submit_invoice_documents(worker,'2099-05-01',true,true,'2099-06-01',
  '[{"date":null,"description":"保管料","quantity":1,"unit_price":1500}]','管理で保存',null);
 select * into inv from app.delivery_invoices where id=(result->'invoice'->>'id')::uuid;
 if inv.total<>2100 or inv.version<>1 then raise exception 'Admin source save failed'; end if;
 perform set_config('request.jwt.claim.sub',worker_login,true);
 if not exists(select 1 from app.delivery_invoices where id=inv.id and note='管理で保存' and total=2100) then
  raise exception 'Delivery cannot read the same source invoice';
 end if;
 result:=app.submit_invoice_documents(worker,'2099-05-01',true,true,'2099-06-02',
  inv.extras||'[{"date":"2099-05-02","description":"追加手当","quantity":2,"unit_price":200}]','納品で追加',1);
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>2500 or inv.version<>2 or (result->>'receipt_version')::integer<>2 then
  raise exception 'Delivery additions were not saved to the original invoice';
 end if;
 failed:=false;
 begin perform app.submit_invoice_documents(worker,'2099-05-01',true,true,'2099-06-02','[]','旧版上書き',1);
 exception when others then if sqlerrm like '%更新%' then failed:=true; else raise; end if; end;
 if not failed then raise exception 'Old invoice version could overwrite shared changes'; end if;
 perform set_config('request.jwt.claim.sub',admin_login,true);
 if (select note from app.delivery_invoices where id=inv.id)<>'納品で追加' then raise exception 'Admin source did not reflect delivery'; end if;
 result:=app.submit_invoice_documents(worker,'2099-05-01',true,true,'2099-06-03',
  inv.extras||'[{"date":null,"description":"追加項目","quantity":1,"unit_price":100}]','共通保存',2);
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>2600 or inv.version<>3 or inv.snapshot->'extras' is distinct from inv.extras then
  raise exception 'Original invoice extras and preview snapshot diverged';
 end if;
 -- Existing corrections from the removed editor remain valid when using the common form.
 result:=app.admin_edit_invoice(inv.id,3,3,'2099-06-03',
  '[{"date":"2099-05-01","description":"既存修正","quantity":1,"unit_price":1000}]',
  inv.extras,inv.snapshot->'receipt_lines',inv.note);
 select * into inv from app.delivery_invoices where id=inv.id;
 perform set_config('request.jwt.claim.sub',worker_login,true);
 result:=app.submit_invoice_documents(worker,'2099-05-01',true,true,'2099-06-04',
  inv.extras||'[{"date":null,"description":"互換追加","quantity":1,"unit_price":100}]','既存修正を維持',4);
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>3700 or inv.version<>5 or inv.snapshot->'lines'->0->>'description'<>'既存修正' then
  raise exception 'Shared form discarded an existing correction';
 end if;
 if exists(select 1 from app.delivery_invoice_approvals where invoice_id=inv.id) then raise exception 'Saving approved the invoice'; end if;
 perform set_config('request.jwt.claim.sub',admin_login,true);
 expense:=app.approve_invoice_documents(inv.id,5,4,'2099-05-31');
 if (select amount from app.expenses where id=expense)<>3700 then raise exception 'Approval did not use the shared source amount'; end if;
 execute 'reset role';
end $test$;
rollback;
