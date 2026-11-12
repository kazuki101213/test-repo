-- An approval and its notification are committed together. The invoice is
-- locked by the approval RPC and can no longer be edited once approved.
create table app.invoice_approval_line_outbox (
  invoice_id uuid primary key references app.delivery_invoice_approvals(invoice_id),
  staff_id uuid not null references app.staff(id),
  invoice_version integer not null,
  billing_month date not null,
  total bigint not null check (total > 0),
  staff_name text not null,
  -- Retain the binding generation even if it is unlinked. Never redirect a
  -- notification already bound to one LINE account to a different account.
  link_id uuid,
  retry_key uuid not null unique default gen_random_uuid(),
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','link_changed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  sent_at timestamptz,
  last_status integer,
  lease uuid
);
create index invoice_approval_line_due on app.invoice_approval_line_outbox(next_attempt_at)
  where state in ('pending','sending');
alter table app.invoice_approval_line_outbox enable row level security;
revoke all on app.invoice_approval_line_outbox from public,anon,authenticated;
grant select,update on app.invoice_approval_line_outbox to service_role;
grant select(id,staff_id,version,billing_month,total) on app.delivery_invoices to service_role;

create function app.capture_invoice_approval_line() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into app.invoice_approval_line_outbox(invoice_id,staff_id,invoice_version,billing_month,total,staff_name,link_id)
  select i.id,i.staff_id,i.version,i.billing_month,i.total,s.name,l.id
  from app.delivery_invoices i
  join app.staff s on s.id=i.staff_id
  join app.expenses e on e.id=new.expense_id and e.staff_id=i.staff_id
    and e.amount=i.total and e.category='外注費' and e.memo='納品請求書 '||i.id::text
  left join app.delivery_line_links l on l.staff_id=i.staff_id and not l.blocked
  where i.id=new.invoice_id and i.total>0
  on conflict do nothing;
  return new;
end $$;
create trigger capture_invoice_approval_line after insert on app.delivery_invoice_approvals
  for each row execute function app.capture_invoice_approval_line();

create function app.claim_invoice_approval_line()
returns table(invoice_id uuid,lease uuid,retry_key uuid,billing_month text,total bigint,staff_name text)
language plpgsql security invoker set search_path='' as $$
begin
  update app.invoice_approval_line_outbox o set state='link_changed',lease=null
  where o.state in ('pending','sending') and o.next_attempt_at<=now() and o.link_id is not null
    and not exists(select 1 from app.delivery_line_links l where l.staff_id=o.staff_id and l.id=o.link_id);
  update app.invoice_approval_line_outbox o set state='failed',lease=null
  where o.state in ('pending','sending') and o.next_attempt_at<=now()
    and (o.attempts>=5 or o.first_attempt_at<=now()-interval '23 hours');

  return query with due as (
    select o.invoice_id,l.id as link_id
    from app.invoice_approval_line_outbox o
    join app.delivery_line_links l on l.staff_id=o.staff_id and not l.blocked
      and (o.link_id is null or o.link_id=l.id)
    join app.staff s on s.id=o.staff_id and s.is_active
    join app.delivery_invoices i on i.id=o.invoice_id and i.staff_id=o.staff_id
      and i.billing_month=o.billing_month and i.version=o.invoice_version and i.total=o.total
    where o.state in ('pending','sending') and o.next_attempt_at<=now()
    order by o.next_attempt_at,o.invoice_id limit 3 for update of o skip locked
  ), claimed as (
    update app.invoice_approval_line_outbox o
    set state='sending',link_id=d.link_id,lease=gen_random_uuid(),attempts=o.attempts+1,
      first_attempt_at=coalesce(o.first_attempt_at,now()),next_attempt_at=now()+interval '2 minutes'
    from due d where o.invoice_id=d.invoice_id
    returning o.invoice_id,o.lease,o.retry_key,o.billing_month,o.total,o.staff_name
  ) select c.invoice_id,c.lease,c.retry_key,to_char(c.billing_month,'YYYY-MM'),c.total,c.staff_name from claimed c;
end $$;

create function app.invoice_approval_line_recipient(p_invoice uuid,p_lease uuid) returns text
language sql security invoker set search_path='' as $$
  select l.line_user_id
  from app.invoice_approval_line_outbox o
  join app.delivery_line_links l on l.id=o.link_id and l.staff_id=o.staff_id and not l.blocked
  join app.staff s on s.id=o.staff_id and s.is_active
  where o.invoice_id=p_invoice and o.lease=p_lease and o.state='sending' and o.next_attempt_at>now();
$$;

create function app.finish_invoice_approval_line(p_invoice uuid,p_lease uuid,p_state text,p_status integer)
returns void language sql security invoker set search_path='' as $$
  update app.invoice_approval_line_outbox
  set state=p_state,last_status=p_status,lease=null,
    sent_at=case when p_state='sent' then now() end,
    next_attempt_at=now()+interval '1 minute'*power(2,attempts-1)
  where invoice_id=p_invoice and lease=p_lease and state='sending'
    and p_state in ('pending','sent','failed');
$$;

-- Only dispatch when there is actionable work. Unlinked recipients remain
-- queued and become eligible when the same staff account is linked.
create function app.kick_invoice_approval_line() returns bigint
language plpgsql security invoker set search_path='' as $$
declare dispatch_token text; project_url text; request_id bigint;
begin
  if not exists(
    select 1 from app.invoice_approval_line_outbox o
    left join app.delivery_line_links l on l.staff_id=o.staff_id
    join app.staff s on s.id=o.staff_id
    where o.state in ('pending','sending') and o.next_attempt_at<=now()
      and ((s.is_active and l.id is not null and not l.blocked)
        or (o.link_id is not null and l.id is distinct from o.link_id)
        or o.attempts>=5 or o.first_attempt_at<=now()-interval '23 hours')
  ) then return null; end if;
  select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
  select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
  if dispatch_token is null or project_url is null then return null; end if;
  select net.http_post(url:=project_url||'/functions/v1/delivery-line',
    headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
    body:='{"action":"dispatch-invoice-approvals"}'::jsonb,timeout_milliseconds:=35000) into request_id;
  return request_id;
end $$;

create function app.invoice_approval_line_status(p_invoice uuid) returns text
language sql stable security definer set search_path='' as $$
  select case
    when o.state not in ('pending','sending') then o.state
    when o.link_id is not null and l.id is distinct from o.link_id then 'link_changed'
    when l.id is null or l.blocked or not s.is_active then 'waiting_link'
    else o.state end
  from app.invoice_approval_line_outbox o
  join app.staff s on s.id=o.staff_id
  left join app.delivery_line_links l on l.staff_id=o.staff_id
  where o.invoice_id=p_invoice and auth.uid() is not null and (select app.is_admin())
    and exists(select 1 from app.staff a where a.id=app.current_staff_id() and a.is_active);
$$;

revoke all on function app.capture_invoice_approval_line(),app.claim_invoice_approval_line(),
  app.invoice_approval_line_recipient(uuid,uuid),app.finish_invoice_approval_line(uuid,uuid,text,integer),
  app.kick_invoice_approval_line(),app.invoice_approval_line_status(uuid) from public,anon,authenticated;
grant execute on function app.claim_invoice_approval_line(),app.invoice_approval_line_recipient(uuid,uuid),
  app.finish_invoice_approval_line(uuid,uuid,text,integer) to service_role;
grant execute on function app.invoice_approval_line_status(uuid) to authenticated;
select cron.schedule('invoice-approval-line','* * * * *','select app.kick_invoice_approval_line();');
notify pgrst,'reload schema';
