alter table app.delivery_push_subscriptions add column app_kind text not null default 'delivery'
  check(app_kind in ('admin','delivery'));

create table app.admin_push_events (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references app.staff(id) on delete cascade,
  kind text not null check(kind in ('malfunction','action','photo_review','invoice','receipts')),
  source_id uuid not null,
  item_id uuid references app.items(id) on delete cascade,
  invoice_staff_id uuid references app.staff(id) on delete cascade,
  billing_month date,
  source_version integer,
  event_at timestamptz not null,
  source_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(staff_id,source_key)
);
create index admin_push_events_staff_idx on app.admin_push_events(staff_id,created_at);
create index admin_push_events_item_idx on app.admin_push_events(item_id);
create index admin_push_events_invoice_staff_idx on app.admin_push_events(invoice_staff_id,billing_month,created_at);
create table app.admin_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references app.admin_push_events(id) on delete cascade,
  subscription_id uuid not null references app.delivery_push_subscriptions(id) on delete cascade,
  state text not null default 'pending' check(state in ('pending','sending','sent','cancelled','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_status integer,
  unique(event_id,subscription_id)
);
create index admin_push_deliveries_subscription_idx on app.admin_push_deliveries(subscription_id);
create index admin_push_deliveries_pending_idx on app.admin_push_deliveries(next_attempt_at) where state in ('pending','sending');
alter table app.admin_push_events enable row level security;
alter table app.admin_push_deliveries enable row level security;
revoke all on app.admin_push_events,app.admin_push_deliveries from public,anon,authenticated;
grant all on app.admin_push_events,app.admin_push_deliveries to service_role;

create function app.enqueue_admin_push(p_kind text,p_source uuid,p_item uuid,p_staff uuid,p_month date,p_version integer,p_at timestamptz)
returns void language sql security definer set search_path='' as $$
  insert into app.admin_push_events(staff_id,kind,source_id,item_id,invoice_staff_id,billing_month,source_version,event_at,source_key)
  select s.id,p_kind,p_source,p_item,p_staff,p_month,p_version,p_at,
    concat_ws(':',p_kind,p_source,p_month,p_version,extract(epoch from p_at))
  from app.staff s where s.is_active and (s.role='admin' or (p_kind='malfunction' and s.role='purchaser'
    and exists(select 1 from app.items i where i.id=p_item and i.purchaser_id=s.id)))
  on conflict(staff_id,source_key) do nothing;
$$;
revoke all on function app.enqueue_admin_push(text,uuid,uuid,uuid,date,integer,timestamptz) from public,anon,authenticated;

create function app.capture_admin_push() returns trigger
language plpgsql security definer set search_path='' as $$
declare should_send boolean;
begin
  if tg_table_name='items' then
    should_send:=new.malfunction_reported and new.malfunction_resolved_at is null and new.malfunction_reported_at is not null;
    if tg_op='UPDATE' then should_send:=should_send and
      (not old.malfunction_reported or new.malfunction_reported_at is distinct from old.malfunction_reported_at
        or old.malfunction_resolved_at is not null); end if;
    if should_send then perform app.enqueue_admin_push('malfunction',new.id,new.id,null,null,null,new.malfunction_reported_at); end if;
  elsif tg_table_name='item_comments' then
    should_send:=new.task_kind is not null and new.task_completed_at is null;
    if tg_op='UPDATE' then should_send:=should_send and
      (new.task_kind is distinct from old.task_kind or old.task_completed_at is not null); end if;
    if should_send then perform app.enqueue_admin_push('action',new.id,new.item_id,null,null,null,
      case when tg_op='INSERT' then new.created_at else clock_timestamp() end); end if;
  elsif tg_table_name='photo_reviews' then
    should_send:=new.submitted_at is not null and new.approved_at is null;
    if tg_op='UPDATE' then should_send:=should_send and
      (new.submitted_at is distinct from old.submitted_at or old.approved_at is not null); end if;
    if should_send then perform app.enqueue_admin_push('photo_review',new.item_id,new.item_id,null,null,null,new.submitted_at); end if;
  elsif tg_table_name='delivery_invoices' then
    should_send:=not exists(select 1 from app.delivery_invoice_approvals where invoice_id=new.id);
    if tg_op='UPDATE' then should_send:=should_send and new.version is distinct from old.version; end if;
    if should_send then perform app.enqueue_admin_push('invoice',new.id,null,new.staff_id,new.billing_month,new.version,new.updated_at); end if;
  else
    perform app.enqueue_admin_push('receipts',new.staff_id,null,new.staff_id,new.billing_month,new.version,new.submitted_at);
  end if;
  return new;
end;
$$;
revoke all on function app.capture_admin_push() from public,anon,authenticated;
create trigger items_admin_push after insert or update of malfunction_reported,malfunction_reported_at,malfunction_resolved_at
  on app.items for each row execute function app.capture_admin_push();
create trigger item_comments_admin_push after insert or update of task_kind,task_completed_at
  on app.item_comments for each row execute function app.capture_admin_push();
create trigger photo_reviews_admin_push after insert or update of submitted_at,approved_at
  on app.photo_reviews for each row execute function app.capture_admin_push();
create trigger invoices_admin_push after insert or update of version on app.delivery_invoices for each row execute function app.capture_admin_push();
create trigger receipts_admin_push after insert or update on app.invoice_receipt_submissions for each row execute function app.capture_admin_push();

create function app.claim_admin_push()
returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text,base_url text,item_id uuid,lot_seq integer,kind text,
  task_id uuid,invoice_staff_id uuid,billing_month date,owner_name text,task_name text,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
  update app.admin_push_deliveries set state='failed' where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.admin_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.admin_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='admin' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' on conflict do nothing;
  return query
  with ready as (
    select d.id from app.admin_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and d.attempts<5
    order by d.next_attempt_at limit 20 for update skip locked
  ), claimed as (
    update app.admin_push_deliveries d set state='sending',attempts=d.attempts+1,next_attempt_at=now()+interval '5 minutes'
    from ready where d.id=ready.id returning d.*
  )
  select d.id,s.id,s.endpoint,s.p256dh,s.auth,s.base_url,e.item_id,i.lot_seq,e.kind,
    case when e.kind='action' then e.source_id end,e.invoice_staff_id,e.billing_month,coalesce(owner.display_name,owner.name),c.task_kind,
    coalesce(s.enabled and s.app_kind='admin' and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
      and e.created_at>now()-interval '24 hours'
      and (st.role='admin' or (e.kind='malfunction' and st.role='purchaser' and i.purchaser_id=st.id))
      and case e.kind
        when 'malfunction' then i.malfunction_reported and i.malfunction_resolved_at is null and i.malfunction_reported_at=e.event_at
        when 'action' then c.task_kind is not null and c.task_completed_at is null
        when 'photo_review' then p.approved_at is null and p.submitted_at=e.event_at
        when 'invoice' then inv.version=e.source_version and not exists(select 1 from app.delivery_invoice_approvals a where a.invoice_id=inv.id)
        else rec.version=e.source_version and not exists(select 1 from app.delivery_invoices vi join app.delivery_invoice_approvals a on a.invoice_id=vi.id
          where vi.staff_id=e.invoice_staff_id and vi.billing_month=e.billing_month) end
      and (e.kind not in ('invoice','receipts') or not exists(
        select 1 from app.admin_push_events newer where newer.staff_id=e.staff_id and newer.invoice_staff_id=e.invoice_staff_id
          and newer.billing_month=e.billing_month and newer.kind in ('invoice','receipts') and newer.created_at>e.created_at)),false)
  from claimed d join app.admin_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id join app.staff st on st.id=s.staff_id
    left join app.items i on i.id=e.item_id left join app.item_comments c on c.id=e.source_id and e.kind='action'
    left join app.photo_reviews p on p.item_id=e.item_id
    left join app.delivery_invoices inv on inv.id=e.source_id and e.kind='invoice'
    left join app.invoice_receipt_submissions rec on rec.staff_id=e.invoice_staff_id and rec.billing_month=e.billing_month
    left join app.staff owner on owner.id=e.invoice_staff_id;
end;
$$;
create function app.finish_admin_push(p_id uuid,p_state text,p_status integer) returns void
language sql security definer set search_path='' as $$
  update app.admin_push_deliveries set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
    sent_at=case when p_state='sent' then now() else sent_at end,last_status=p_status,
    next_attempt_at=now()+interval '1 minute'*greatest(1,attempts)
  where id=p_id and state='sending' and p_state in ('pending','sent','cancelled','failed');
$$;
revoke all on function app.claim_admin_push(),app.finish_admin_push(uuid,text,integer) from public,anon,authenticated;
grant execute on function app.claim_admin_push(),app.finish_admin_push(uuid,text,integer) to service_role;

create or replace function app.claim_delivery_push() returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text,base_url text,item_id uuid,lot_seq integer,kind text,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
  update app.delivery_push_deliveries set state='failed'
    where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.delivery_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours'
    on conflict do nothing;
  return query
  with ready as (
    select d.id from app.delivery_push_deliveries d where d.state in ('pending','sending')
      and d.next_attempt_at<=now() and d.attempts<5
    order by d.next_attempt_at limit 20 for update skip locked
  ), claimed as (
    update app.delivery_push_deliveries d set state='sending',attempts=d.attempts+1,next_attempt_at=now()+interval '5 minutes'
      from ready where d.id=ready.id returning d.*
  )
  select d.id,s.id,s.endpoint,s.p256dh,s.auth,s.base_url,i.id,i.lot_seq,e.kind,
    s.enabled and s.app_kind='delivery' and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
    and e.created_at>now()-interval '24 hours'
    and (st.role='admin' or (i.deliverer_id=st.id and st.role='deliverer'))
    and case e.kind
      when 'reply' then i.malfunction_reported_at<e.event_at and coalesce(r.reply_read_at,'-infinity')<e.event_at
      when 'photo' then p.approved_at=e.event_at and coalesce(r.photo_read_at,'-infinity')<e.event_at
      else i.shipped_on is null and i.sold_on is null end
  from claimed d join app.delivery_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id
    join app.staff st on st.id=s.staff_id join app.items i on i.id=e.item_id
    left join app.item_notice_reads r on r.item_id=i.id and r.staff_id=st.id
    left join app.photo_reviews p on p.item_id=i.id;
end;
$$;
create or replace function app.kick_delivery_push() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text; project_url text; request_id bigint;
begin
  if not exists (
    select 1 from app.delivery_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and (d.attempts<5 or d.state='sending')
  ) and not exists (
    select 1 from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' and not exists (
      select 1 from app.delivery_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
    ) and not exists (
    select 1 from app.admin_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and (d.attempts<5 or d.state='sending')
  ) and not exists (
    select 1 from app.admin_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.app_kind='admin' and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' and not exists (
      select 1 from app.admin_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
  ) then return null; end if;
  select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
  select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
  if dispatch_token is null or project_url is null then return null; end if;
  select net.http_post(url:=project_url||'/functions/v1/delivery-push',
    headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
    body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=10000) into request_id;
  return request_id;
end;
$$;
