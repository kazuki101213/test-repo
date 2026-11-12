-- An explicit supplier check is a reply even when the item was marked faulty manually.
do $patch$
declare original text; patched text;
begin
  original := pg_get_functiondef('app.capture_delivery_push()'::regprocedure);
  patched := replace(original,
    'i.malfunction_reported_at<new.created_at and s.role in',
    '(i.malfunction_reported_at<new.created_at
      or (new.task_kind=''仕入先確認'' and i.status=''動作不良'' and i.malfunction_reported_at is null))
      and s.role in');
  if patched=original then raise exception 'Delivery reply trigger source changed'; end if;
  execute patched;

  original := pg_get_functiondef('app.claim_delivery_push()'::regprocedure);
  patched := replace(original,
    'i.malfunction_reported_at<e.event_at and coalesce(r.reply_read_at,',
    '(i.malfunction_reported_at<e.event_at or (i.malfunction_reported_at is null and exists (
       select 1 from app.item_comments c
       where c.item_id=i.id and c.created_at=e.event_at and c.task_kind=''仕入先確認''
     ))) and coalesce(r.reply_read_at,');
  if patched=original then raise exception 'Delivery reply eligibility source changed'; end if;
  execute patched;

  original := pg_get_viewdef('app.v_delivery_notice_tasks'::regclass);
  patched := replace(original, 'c.created_at > i.malfunction_reported_at',
    '(c.created_at > i.malfunction_reported_at or (i.malfunction_reported_at is null and c.task_kind=''仕入先確認''))');
  if patched=original then raise exception 'Delivery reply task source changed'; end if;
  execute 'create or replace view app.v_delivery_notice_tasks with (security_invoker=true) as '||patched;
end;
$patch$;

-- Only the existing dispatcher may read the reply classification.
create or replace function app.claim_delivery_push_with_listing_title()
returns setof jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  claimed record;
  details jsonb;
begin
  for claimed in select * from app.claim_delivery_push() loop
    details := '{}'::jsonb;
    if claimed.kind='photo' then
      select jsonb_build_object('listing_request_title',app.delivery_listing_request_title(item.sales_channel))
      into details from app.items item where item.id=claimed.item_id;
    elsif claimed.kind='reply' and exists (
      select 1
      from app.delivery_push_deliveries delivery
      join app.delivery_push_events event on event.id=delivery.event_id
      join app.item_comments message on message.item_id=event.item_id and message.created_at=event.event_at
      where delivery.id=claimed.delivery_id and message.task_kind='仕入先確認'
    ) then
      details := jsonb_build_object('reply_task_kind','仕入先確認');
    end if;
    return next to_jsonb(claimed) || coalesce(details,'{}'::jsonb);
  end loop;
end;
$$;
revoke all on function app.claim_delivery_push_with_listing_title() from public,anon,authenticated;
grant execute on function app.claim_delivery_push_with_listing_title() to service_role;
