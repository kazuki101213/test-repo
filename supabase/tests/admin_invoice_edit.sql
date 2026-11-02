begin;
do $test$
declare worker uuid; admin_login text; worker_login text; receipt uuid:=gen_random_uuid(); inv app.delivery_invoices;
 result jsonb; expected_profile jsonb; failed boolean; receipt_version integer; expense uuid;
begin
 select id into worker from app.staff where code='DD';
 select user_id::text into admin_login from app.profiles where staff_id=(select id from app.staff where code='AA') limit 1;
 select user_id::text into worker_login from app.profiles where staff_id=worker limit 1;
 perform set_config('request.jwt.claim.sub',admin_login,true);
 insert into app.delivery_invoice_profiles(staff_id,details,enabled,unit_price,tax_percent)
 values(worker,'{"issuer_name":"編集検証","recipient":"宛先保持","bank":"銀行保持"}',true,500,10)
 on conflict(staff_id) do update set details=excluded.details,enabled=true,unit_price=500,tax_percent=10;
 insert into app.invoice_receipts(id,staff_id,billing_month,storage_path,original_name,spent_on,description,amount,include_in_invoice)
 values(receipt,worker,'2099-04-01',worker::text||'/2099-04/'||receipt::text||'.jpg','receipt.jpg','2099-04-01','資材',600,true);
 result:=app.submit_invoice_documents(worker,'2099-04-01',true,true,'2099-05-01','[]','元備考',null);
 select * into inv from app.delivery_invoices where id=(result->'invoice'->>'id')::uuid;
 expected_profile:=inv.snapshot->'profile';
 execute 'set local role authenticated';
 result:=app.admin_edit_invoice(inv.id,inv.version,1,'2099-05-02',
 '[{"date":"2099-04-02","description":"編集した作業","quantity":2,"unit_price":1000}]',
 '[{"date":null,"description":"編集手当","quantity":1,"unit_price":200}]',
 jsonb_build_array(jsonb_build_object('id',receipt,'version',1,'spent_on','2099-04-03','description','編集した資材','amount',700)), '編集備考');
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>3120 or inv.version<>2 or inv.issued_on<>'2099-05-02' or inv.note<>'編集備考'
  or inv.snapshot->'lines'->0->>'description'<>'編集した作業'
  or inv.snapshot->'profile' is distinct from expected_profile then raise exception 'Invoice correction not retained: %',to_jsonb(inv); end if;
 if (result->>'receipt_version')::integer<>2 or (inv.snapshot->'receipt_subtotal')::bigint<>700
  or inv.snapshot->'receipt_lines' is distinct from app.invoice_receipt_lines(worker,'2099-04-01') then
  raise exception 'Receipt correction was not atomically snapshotted';
 end if;
 if exists(select 1 from app.delivery_invoice_approvals where invoice_id=inv.id) then raise exception 'Save approved the invoice'; end if;
 failed:=false;
 begin perform app.admin_edit_invoice(inv.id,1,2,'2099-05-02','[]','[]',inv.snapshot->'receipt_lines','stale');
 exception when others then if sqlerrm like '%更新%' then failed:=true; else raise; end if; end;
 if not failed then raise exception 'Stale invoice version accepted'; end if;
 failed:=false;
 begin perform app.admin_edit_invoice(inv.id,2,1,'2099-05-02','[]','[]',inv.snapshot->'receipt_lines','stale');
 exception when others then if sqlerrm like '%領収書%' then failed:=true; else raise; end if; end;
 if not failed then raise exception 'Stale receipt submission accepted'; end if;
 failed:=false;
 begin perform app.admin_edit_invoice(inv.id,2,2,'2099-05-02','[{"description":"不正","quantity":0,"unit_price":1}]','[]',inv.snapshot->'receipt_lines','invalid');
 exception when others then failed:=true; end;
 if not failed then raise exception 'Invalid quantity accepted'; end if;
 perform set_config('request.jwt.claim.sub',worker_login,true);
 failed:=false;
 begin perform app.admin_edit_invoice(inv.id,2,2,'2099-05-02','[]','[]',inv.snapshot->'receipt_lines','forbidden');
 exception when insufficient_privilege then failed:=true; end;
 if not failed then raise exception 'Worker could call admin correction'; end if;
 failed:=false;
 begin update app.delivery_invoices set review_content='{}' where id=inv.id;
 exception when insufficient_privilege then failed:=true; end;
 if not failed then raise exception 'Worker could overwrite review content directly'; end if;
 perform set_config('request.jwt.claim.sub',admin_login,true);
 -- Saving a second correction must not add reimbursements twice or overwrite the edited amounts.
 result:=app.admin_edit_invoice(inv.id,2,2,'2099-05-02',inv.snapshot->'lines',inv.extras,inv.snapshot->'receipt_lines','備考だけ再編集');
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>3120 or inv.version<>3 then raise exception 'Repeated save changed totals'; end if;
 expense:=app.approve_invoice_documents(inv.id,3,2,'2099-04-30');
 if (select amount from app.expenses where id=expense)<>3120 then raise exception 'Approval used an old amount'; end if;
 failed:=false;
 begin perform app.admin_edit_invoice(inv.id,3,2,'2099-05-02','[]','[]',inv.snapshot->'receipt_lines','approved');
 exception when others then if sqlerrm like '%承認済み%' then failed:=true; else raise; end if; end;
 if not failed then raise exception 'Approved invoice was editable'; end if;
 execute 'reset role';
 if has_function_privilege('anon','app.admin_edit_invoice(uuid,integer,integer,date,jsonb,jsonb,jsonb,text)','execute') then
  raise exception 'Anonymous invoice editing allowed';
 end if;
end $test$;
rollback;
