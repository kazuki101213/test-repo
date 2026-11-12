begin;
do $test$
declare
  admin_user text;
  worker_user text;
  worker uuid;
  other_worker uuid;
  worker_invoice uuid;
  other_invoice uuid;
  worker_recipient text := 'U'||repeat('a',32);
  other_recipient text := 'U'||repeat('b',32);
  billing date := '2098-02-01';
  claimed record;
  retry record;
  approved_expense uuid;
  saved jsonb;
begin
  select id into strict worker from app.staff where code='DD';
  select id into strict other_worker from app.staff where code='HH';
  select user_id::text into admin_user from app.profiles where staff_id=(select id from app.staff where code='AA') limit 1;
  select user_id::text into worker_user from app.profiles where staff_id=worker limit 1;
  insert into app.delivery_line_links(staff_id,line_user_id) values(worker,worker_recipient);
  insert into app.delivery_invoice_profiles(staff_id,details,enabled,unit_price,tax_percent)
  values (worker,'{"issuer_name":"担当A"}',true,400,0), (other_worker,'{"issuer_name":"担当B"}',true,500,0)
  on conflict(staff_id) do update set details=excluded.details,enabled=true,unit_price=excluded.unit_price,tax_percent=0;

  perform set_config('request.jwt.claim.sub',admin_user,true);
  saved:=app.submit_invoice_documents(worker,billing,true,false,'2098-03-01','[]','',null);
  worker_invoice:=(saved->'invoice'->>'id')::uuid;
  saved:=app.submit_invoice_documents(other_worker,billing,true,false,'2098-03-01','[]','',null);
  other_invoice:=(saved->'invoice'->>'id')::uuid;
  if exists(select 1 from app.invoice_approval_line_outbox where invoice_id in (worker_invoice,other_invoice)) then
    raise exception 'Saving queued an approval notification';
  end if;

  execute 'set local role authenticated';
  perform app.admin_edit_invoice(worker_invoice,1,null,'2098-03-01',
    '[{"description":"試用単価","quantity":2,"unit_price":400}]','[]','[]','');
  perform app.admin_edit_invoice(other_invoice,1,null,'2098-03-01',
    '[{"description":"モニター","quantity":1,"unit_price":450},{"description":"レコーダー","quantity":2,"unit_price":500}]',
    '[{"description":"手当","quantity":1,"unit_price":300}]','[]','');
  begin
    perform app.approve_invoice_documents(worker_invoice,1,null,'2098-02-28');
    raise exception 'Accepted a stale invoice';
  exception when others then
    if sqlerrm not like '%更新%' then raise; end if;
  end;
  approved_expense:=app.approve_invoice_documents(worker_invoice,2,null,'2098-02-28');
  if app.approve_invoice_documents(worker_invoice,2,null,'2098-02-28')<>approved_expense then
    raise exception 'Approval is not idempotent';
  end if;
  perform app.approve_invoice_documents(other_invoice,2,null,'2098-02-28');
  if app.invoice_approval_line_status(worker_invoice) is distinct from 'pending' or
     app.invoice_approval_line_status(other_invoice) is distinct from 'waiting_link' then
    raise exception 'Admin status incorrect';
  end if;
  perform set_config('request.jwt.claim.sub',worker_user,true);
  if app.invoice_approval_line_status(other_invoice) is not null or
     has_table_privilege('authenticated','app.invoice_approval_line_outbox','SELECT') or
     has_function_privilege('authenticated','app.claim_invoice_approval_line()','EXECUTE') then
    raise exception 'Invoice notification exposed to staff';
  end if;
  execute 'reset role';
  execute 'set local role service_role';
  select * into strict claimed from app.claim_invoice_approval_line();
  if claimed.invoice_id<>worker_invoice or claimed.total<>800 or claimed.billing_month<>'2098-02'
     or app.invoice_approval_line_recipient(claimed.invoice_id,claimed.lease) is distinct from worker_recipient then
    raise exception 'Linked invoice crossed owner, month or amount';
  end if;
  if app.invoice_approval_line_recipient(other_invoice,claimed.lease) is not null then
    raise exception 'Lease used for a different invoice';
  end if;
  perform app.finish_invoice_approval_line(claimed.invoice_id,claimed.lease,'pending',503);
  execute 'reset role';
  update app.invoice_approval_line_outbox set next_attempt_at=now() where invoice_id=worker_invoice;
  execute 'set local role service_role';
  select * into strict retry from app.claim_invoice_approval_line();
  if retry.retry_key<>claimed.retry_key or retry.lease=claimed.lease or retry.total<>claimed.total then
    raise exception 'Retry identity or amount changed';
  end if;
  perform app.finish_invoice_approval_line(retry.invoice_id,retry.lease,'sent',409);
  if exists(select 1 from app.claim_invoice_approval_line()) then
    raise exception 'Duplicate or unlinked notification was dispatched';
  end if;
  execute 'reset role';
  insert into app.delivery_line_links(staff_id,line_user_id) values(other_worker,other_recipient);
  execute 'set local role service_role';
  select * into strict claimed from app.claim_invoice_approval_line();
  if claimed.invoice_id<>other_invoice or claimed.total<>1750
     or app.invoice_approval_line_recipient(claimed.invoice_id,claimed.lease) is distinct from other_recipient then
    raise exception 'Newly linked invoice used another owner or rate';
  end if;
  execute 'reset role';
  perform app.unlink_delivery_line(other_worker);
  insert into app.delivery_line_links(staff_id,line_user_id) values(other_worker,'U'||repeat('c',32));
  execute 'set local role service_role';
  if app.invoice_approval_line_recipient(claimed.invoice_id,claimed.lease) is not null then
    raise exception 'A changed LINE binding received the invoice';
  end if;
  perform app.finish_invoice_approval_line(claimed.invoice_id,claimed.lease,'pending',null);
  execute 'reset role';
  update app.invoice_approval_line_outbox set next_attempt_at=now() where invoice_id=other_invoice;
  execute 'set local role service_role';
  if exists(select 1 from app.claim_invoice_approval_line()) then
    raise exception 'A retry followed a replaced binding';
  end if;
  execute 'reset role';
  if (select state from app.invoice_approval_line_outbox where invoice_id=other_invoice) is distinct from 'link_changed' then
    raise exception 'Replaced binding was not recorded';
  end if;
end $test$;
rollback;
