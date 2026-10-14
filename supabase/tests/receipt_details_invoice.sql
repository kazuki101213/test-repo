begin;
do $test$
declare buyer uuid; worker uuid; receipt uuid:=gen_random_uuid(); inv app.delivery_invoices; result jsonb; n bigint; fail boolean;
begin
 select id into buyer from app.staff where code='AA'; select id into worker from app.staff where code='DD';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 update app.delivery_invoice_profiles set enabled=true,unit_price=500,tax_percent=10 where staff_id=worker;
 insert into app.invoice_receipts(id,staff_id,billing_month,storage_path,original_name,spent_on,description,amount,payee,include_in_invoice)
 values(receipt,worker,'2099-01-01',worker::text||'/2099-01/'||receipt::text||'.jpg','receipt.jpg','2098-12-31','資材費',1100,'販売店',true);
 insert into app.invoice_receipts(staff_id,billing_month,storage_path,original_name,spent_on,description,amount,include_in_invoice)
 values(worker,'2099-01-01',worker::text||'/2099-01/'||gen_random_uuid()::text||'.jpg','excluded.jpg','2099-01-01','請求外',900,false);
 result:=app.submit_invoice_documents(worker,'2099-01-01',true,true,'2099-02-01','[{"date":null,"description":"手当","quantity":1,"unit_price":1000}]','',null);
 select * into inv from app.delivery_invoices where id=(result->'invoice'->>'id')::uuid;
 if inv.total<>2200 or (inv.snapshot->>'tax')::bigint<>100 or (inv.snapshot->>'receipt_subtotal')::bigint<>1100 then raise exception 'Tax-inclusive receipt charged twice or excluded rows charged: %',inv.snapshot; end if;
 if jsonb_array_length(inv.snapshot->'receipt_lines')<>1 or inv.snapshot->'receipt_lines'->0->>'description'<>'資材費' then raise exception 'Details not snapshotted'; end if;
 if not exists(select 1 from app.invoice_receipt_submissions s cross join lateral jsonb_array_elements(s.files) x where s.staff_id=worker and s.billing_month='2099-01-01' and x->>'description'='資材費' and (x->>'amount')::bigint=1100) then raise exception 'Receipt submission metadata missing'; end if;
 update app.invoice_receipts set amount=1200 where id=receipt;
 fail:=false;
 begin perform app.approve_delivery_invoice(inv.id,inv.version,'2099-02-01'); exception when others then if sqlerrm like '%再送信%' then fail:=true; else raise; end if; end;
 if not fail then raise exception 'Stale invoice approval allowed'; end if;
 result:=app.submit_invoice_documents(worker,'2099-01-01',true,true,'2099-02-01',inv.extras,'',inv.version);
 select * into inv from app.delivery_invoices where id=inv.id;
 if inv.total<>2300 or inv.version<>2 then raise exception 'Re-submission duplicated receipts: %',inv.total; end if;
 perform app.approve_delivery_invoice(inv.id,inv.version,'2099-02-01');
 fail:=false;
 begin update app.invoice_receipts set amount=1300 where id=receipt; exception when others then if sqlerrm like '%承認済み%' then fail:=true; else raise; end if; end;
 if not fail then raise exception 'Approved receipt edited'; end if;
 fail:=false;
 begin insert into app.invoice_receipts(staff_id,billing_month,storage_path,original_name,include_in_invoice) values(worker,'2099-03-01',worker::text||'/2099-03/'||gen_random_uuid()::text||'.jpg','bad.jpg',true); exception when check_violation then fail:=true; end;
 if not fail then raise exception 'Incomplete claimed receipt accepted'; end if;
 -- Exercise real authenticated grants and ownership policies, not only postgres.
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=worker limit 1),true);
 execute 'set local role authenticated';
 update app.invoice_receipts set memo='owner edit' where staff_id=worker and billing_month='2099-03-01';
 select count(*) into n from app.invoice_receipts where staff_id=worker and billing_month='2099-01-01';
 if n<>2 then raise exception 'Own receipts unavailable through RLS'; end if;
 execute 'reset role';
end $test$;
rollback;