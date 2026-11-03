begin;
select set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA' limit 1),true);
insert into app.expense_drafts(id,target_month,category,name) values('99000100-0000-0000-0000-000000000001','2099-11-01','固定費','削除検証');
insert into app.expenses(id,incurred_on,category,name,amount) values
 ('99000100-0000-0000-0000-000000000001','2099-11-01','固定費','削除検証',100),
 ('99000100-0000-0000-0000-000000000002','2099-11-02','変動費','変更検証',200),
 ('99000100-0000-0000-0000-000000000003','2099-11-03','外注費','残す経費',900);
select set_config('expense_test.worker_login',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='DD' limit 1),true);
set local role authenticated;
do $$
declare payload jsonb; request uuid:=gen_random_uuid(); failed boolean; worker_login text:=current_setting('expense_test.worker_login');
begin
 select jsonb_agg(to_jsonb(e)-'created_at'-'updated_at'-'deleted_at'-'deletion_batch' order by id) into payload
 from app.expenses e where id in ('99000100-0000-0000-0000-000000000001','99000100-0000-0000-0000-000000000002');
 if (select "経費" from app.v_monthly_summary where month='2099-11-01')<>1200 then raise exception 'Initial accounting mismatch';end if;
 update app.expenses set amount=201 where id='99000100-0000-0000-0000-000000000002';
 failed:=false;
 begin perform app.delete_expenses(payload,request);exception when serialization_failure then failed:=true;end;
 if not failed or exists(select 1 from app.expenses where id='99000100-0000-0000-0000-000000000001' and deleted_at is not null)
 or exists(select 1 from app.expense_deletion_batches where id=request) then raise exception 'A stale row caused a partial delete';end if;
 update app.expenses set amount=200 where id='99000100-0000-0000-0000-000000000002';
 if app.delete_expenses(payload,request)<>2 or app.delete_expenses(payload,request)<>2 then raise exception 'Delete/retry count mismatch';end if;
 if (select count(*) from app.expenses where id::text like '99000100-%' and deleted_at is null)<>1 then raise exception 'Wrong active rows';end if;
 if (select "経費" from app.v_monthly_summary where month='2099-11-01')<>900 then raise exception 'Deleted expenses remain in monthly report';end if;
 if not exists(select 1 from app.expense_drafts where id='99000100-0000-0000-0000-000000000001' and deleted_at is not null) then raise exception 'Deleted draft can reappear';end if;
 failed:=false;
 begin perform app.delete_expenses(payload||payload,gen_random_uuid());exception when invalid_parameter_value then failed:=true;end;
 if not failed then raise exception 'Duplicate IDs accepted';end if;
 failed:=false;
 begin perform app.delete_expenses(payload->0,gen_random_uuid());exception when invalid_parameter_value then failed:=true;end;
 if not failed then raise exception 'Invalid input accepted';end if;
 failed:=false;
 begin perform app.delete_expenses(jsonb_build_array(payload->0),request);exception when invalid_parameter_value then failed:=true;end;
 if not failed then raise exception 'Request ID reused for different content';end if;
 perform set_config('request.jwt.claim.sub',worker_login,true);
 failed:=false;
 begin perform app.delete_expenses(payload,gen_random_uuid());exception when insufficient_privilege then failed:=true;end;
 if not failed or exists(select 1 from app.expense_deletion_batches) then raise exception 'Non-admin could delete/read deletion history';end if;
 if has_function_privilege('anon','app.delete_expenses(jsonb,uuid)','execute') then raise exception 'Anonymous delete enabled';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA' limit 1),true);
insert into app.delivery_invoice_profiles(staff_id,details,enabled,unit_price,tax_percent)
select id,'{"issuer_name":"削除連動検証"}',true,500,0 from app.staff where code='DD'
on conflict(staff_id) do update set details=excluded.details,enabled=true,unit_price=500,tax_percent=0;
set local role authenticated;
do $$
declare documents jsonb; invoice uuid; expense uuid; payload jsonb; result uuid;
begin
 documents:=app.submit_invoice_documents((select id from app.staff where code='DD'),'2099-12-01',true,false,'2100-01-01','[{"date":null,"description":"検証料金","quantity":1,"unit_price":500}]','',null);
 invoice:=(documents->'invoice'->>'id')::uuid;
 expense:=app.approve_delivery_invoice(invoice,1,'2099-12-31');
 select jsonb_build_array(to_jsonb(e)-'created_at'-'updated_at'-'deleted_at'-'deletion_batch') into payload from app.expenses e where id=expense;
 perform app.delete_expenses(payload,gen_random_uuid());
 if not exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice and expense_id=expense) then raise exception 'Approval link lost';end if;
 result:=app.approve_delivery_invoice(invoice,1,'2099-12-31');
 if result<>expense or (select count(*) from app.expenses where memo='納品請求書 '||invoice::text)<>1 then raise exception 'Deleted invoice expense duplicated on retry';end if;
 if exists(select 1 from app.v_monthly_summary where month='2099-12-01' and "経費"<>0) then raise exception 'Linked deleted expense remains in total';end if;
end $$;
rollback;
