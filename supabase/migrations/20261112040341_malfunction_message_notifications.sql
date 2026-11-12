alter table app.admin_push_events drop constraint admin_push_events_kind_check;
alter table app.admin_push_events add constraint admin_push_events_kind_check
  check (kind in ('malfunction','action','photo_review','invoice','receipts','packing_photo','malfunction_message'));

-- A comment from the assigned delivery worker belongs in the management app.
create function app.capture_admin_malfunction_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
  if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then
    return new;
  end if;

  insert into app.admin_push_events(staff_id,kind,source_id,item_id,event_at,source_key)
  select recipient.id,'malfunction_message',new.id,i.id,new.created_at,'malfunction_message:'||new.id
  from app.items i
  join app.staff author on author.id=new.author_id and author.is_active
  join app.staff recipient on recipient.is_active and recipient.id<>author.id
    and (recipient.role='admin' or (recipient.role='purchaser' and recipient.id=i.purchaser_id))
  where i.id=new.item_id and i.deliverer_id=author.id
    and (author.role='deliverer' or (author.role='purchaser' and author.id is distinct from i.purchaser_id))
    and i.malfunction_reported and i.malfunction_resolved_at is null
    and (i.status='動作不良' or (i.status='Amazon補填申請中'
      and i.compensation_report_completed_for is distinct from i.malfunction_reported_at))
    and i.sold_on is null and new.created_at>i.malfunction_reported_at
  on conflict (staff_id,source_key) do nothing;
  return new;
end;
$$;
revoke all on function app.capture_admin_malfunction_message() from public,anon,authenticated;

create trigger item_comments_admin_malfunction_message
after insert on app.item_comments for each row when (new.task_kind is null)
execute function app.capture_admin_malfunction_message();

-- Do not send a second copy to the delivery app when a purchaser is acting as the delivery worker.
create or replace function app.capture_delivery_push() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
  if tg_table_name='item_comments' then
    if exists(select 1 from app.delivery_return_tasks where id=new.id) then return new;end if;
    if exists(
      select 1 from app.items i join app.staff s on s.id=new.author_id
      where i.id=new.item_id and i.malfunction_reported_at<new.created_at and s.role in ('admin','purchaser')
        and not (new.task_kind is null and s.role='purchaser'
          and s.is_active and s.id is not distinct from i.deliverer_id and s.id is distinct from i.purchaser_id
          and i.malfunction_reported and i.malfunction_resolved_at is null and i.sold_on is null
          and (i.status='動作不良' or (i.status='Amazon補填申請中'
            and i.compensation_report_completed_for is distinct from i.malfunction_reported_at)))
    ) then
      perform app.enqueue_delivery_push(new.item_id,'reply',new.created_at,new.author_id);
    end if;
  elsif tg_table_name='photo_reviews' then
    if new.approved_at is not null then
      if tg_op='INSERT' then
        perform app.enqueue_delivery_push(new.item_id,'photo',new.approved_at,new.approved_by);
      elsif new.approved_at is distinct from old.approved_at then
        perform app.enqueue_delivery_push(new.item_id,'photo',new.approved_at,new.approved_by);
      end if;
    end if;
  else
    if new.deliverer_id is not null and new.shipped_on is null and new.sold_on is null then
      if tg_op='INSERT' then
        perform app.enqueue_delivery_push(new.id,'assigned',clock_timestamp(),app.current_staff_id());
      elsif new.deliverer_id is distinct from old.deliverer_id then
        perform app.enqueue_delivery_push(new.id,'assigned',clock_timestamp(),app.current_staff_id());
      end if;
    end if;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION app.claim_admin_push()
 RETURNS TABLE(delivery_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text, base_url text, item_id uuid, lot_seq integer, kind text, task_id uuid, invoice_staff_id uuid, billing_month date, owner_name text, task_name text, eligible boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    case when e.kind in ('action','malfunction_message') then e.source_id end,e.invoice_staff_id,e.billing_month,coalesce(owner.display_name,owner.name),c.task_kind,
    coalesce(s.enabled and s.app_kind='admin' and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
      and e.created_at>now()-interval '24 hours'
      and (st.role='admin' or (e.kind in ('malfunction','malfunction_message') and st.role='purchaser' and i.purchaser_id=st.id))
      and case e.kind
        when 'packing_photo' then exists(select 1 from app.packing_photo_notices n where n.item_id=e.item_id and n.submitted_at=e.event_at and n.checked_at is null and exists(select 1 from app.item_photos p where p.item_id=n.item_id and p.photo_kind='packing'))
        when 'malfunction' then i.malfunction_reported and i.malfunction_resolved_at is null and i.malfunction_reported_at=e.event_at
        when 'malfunction_message' then c.item_id=i.id and c.created_at=e.event_at
          and c.author_id<>st.id and c.created_at>i.malfunction_reported_at
          and i.malfunction_reported and i.malfunction_resolved_at is null
          and (i.status='動作不良' or (i.status='Amazon補填申請中'
            and i.compensation_report_completed_for is distinct from i.malfunction_reported_at))
          and i.sold_on is null
        when 'action' then c.task_kind is not null and c.task_kind<>'仕入先確認' and c.task_kind not like '%ヤフオク%' and c.task_completed_at is null
        when 'photo_review' then p.rejected_at is null and p.approved_at is null and p.submitted_at=e.event_at
        when 'invoice' then inv.version=e.source_version and not exists(select 1 from app.delivery_invoice_approvals a where a.invoice_id=inv.id)
        else rec.version=e.source_version and not exists(select 1 from app.delivery_invoices vi join app.delivery_invoice_approvals a on a.invoice_id=vi.id
          where vi.staff_id=e.invoice_staff_id and vi.billing_month=e.billing_month) end
      and (e.kind not in ('invoice','receipts') or not exists(
        select 1 from app.admin_push_events newer where newer.staff_id=e.staff_id and newer.invoice_staff_id=e.invoice_staff_id
          and newer.billing_month=e.billing_month and newer.kind in ('invoice','receipts') and newer.created_at>e.created_at)),false)
  from claimed d join app.admin_push_events e on e.id=d.event_id
    join app.delivery_push_subscriptions s on s.id=d.subscription_id join app.staff st on st.id=s.staff_id
    left join app.items i on i.id=e.item_id left join app.item_comments c on c.id=e.source_id and e.kind in ('action','malfunction_message')
    left join app.photo_reviews p on p.item_id=e.item_id
    left join app.delivery_invoices inv on inv.id=e.source_id and e.kind='invoice'
    left join app.invoice_receipt_submissions rec on rec.staff_id=e.invoice_staff_id and rec.billing_month=e.billing_month
    left join app.staff owner on owner.id=e.invoice_staff_id;
end;
$function$;
