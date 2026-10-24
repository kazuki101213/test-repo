-- Push wakes on new events. A temporary, self-removing alarm covers transport
-- failure and claim leases; an empty queue has no recurring DB or HTTP work.
create function app.arm_delivery_push_retry() returns void
language plpgsql security definer set search_path='' as $$
declare due_at timestamptz; newest timestamptz; alarm_at timestamptz; spec text; age interval;
begin
  perform pg_advisory_xact_lock(1735907191);
  select min(next_attempt_at),max(created_at) into due_at,newest from (
    select d.next_attempt_at,e.created_at from app.delivery_push_deliveries d
      join app.delivery_push_events e on e.id=d.event_id
      where d.state in ('pending','sending') and (d.attempts<5 or d.state='sending')
        and e.created_at>now()-interval '24 hours'
    union all
    select d.next_attempt_at,e.created_at from app.admin_push_deliveries d
      join app.admin_push_events e on e.id=d.event_id
      where d.state in ('pending','sending') and (d.attempts<5 or d.state='sending')
        and e.created_at>now()-interval '24 hours'
    union all
    select now(),e.created_at from app.delivery_push_events e
      join app.delivery_push_subscriptions s on s.staff_id=e.staff_id
        and s.app_kind='delivery' and s.enabled and s.created_at<=e.created_at
      where e.created_at>now()-interval '24 hours' and not exists(
        select 1 from app.delivery_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
    union all
    select now(),e.created_at from app.admin_push_events e
      join app.delivery_push_subscriptions s on s.staff_id=e.staff_id
        and s.app_kind='admin' and s.enabled and s.created_at<=e.created_at
      where e.created_at>now()-interval '24 hours' and not exists(
        select 1 from app.admin_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
  ) work;
  if due_at is null then
    perform cron.unschedule(jobid) from cron.job where jobname='delivery-push-retry';
    return;
  end if;
  age:=now()-newest;
  -- Failed HTTP requests before a claim back off, rather than poll forever.
  alarm_at:=case when due_at>now() then due_at else now()+case
    when age<interval '5 minutes' then interval '5 minutes'
    when age<interval '15 minutes' then interval '10 minutes'
    when age<interval '35 minutes' then interval '20 minutes'
    when age<interval '75 minutes' then interval '40 minutes'
    else interval '1 hour' end end;
  alarm_at:=date_trunc('minute',alarm_at)+interval '1 minute';
  spec:=to_char(alarm_at at time zone 'UTC','MI HH24 DD MM')||' *';
  if not exists(select 1 from cron.job j where j.jobname='delivery-push-retry' and to_jsonb(j)->>'schedule'=spec) then
    perform cron.schedule('delivery-push-retry',spec,'select app.retry_delivery_push();');
  end if;
end;
$$;

create function app.retry_delivery_push() returns bigint
language plpgsql security definer set search_path='' as $$
declare request_id bigint;
begin
  perform pg_advisory_xact_lock(1735907191);
  perform cron.unschedule(jobid) from cron.job where jobname='delivery-push-retry';
  -- Preserve the existing 24h expiry and five-attempt limit.
  update app.delivery_push_deliveries d set state='cancelled' from app.delivery_push_events e
    where d.event_id=e.id and d.state in ('pending','sending') and e.created_at<=now()-interval '24 hours';
  update app.admin_push_deliveries d set state='cancelled' from app.admin_push_events e
    where d.event_id=e.id and d.state in ('pending','sending') and e.created_at<=now()-interval '24 hours';
  begin
    request_id:=app.kick_delivery_push();
  exception when others then
    raise warning 'Push dispatch unavailable; pending events retained for retry';
  end;
  perform app.arm_delivery_push_retry();
  return request_id;
end;
$$;

-- Keep the current eligibility guards, Vault authentication and HTTP dispatch.
-- Only deduplicate dispatch within a transaction and arm its failure watchdog.
do $$declare source text;begin
  source:=pg_get_functiondef('app.kick_delivery_push()'::regprocedure);
  if position('begin' in source)=0 or position('  return request_id;' in source)=0 then
    raise exception 'Unexpected push dispatcher definition';
  end if;
  source:=replace(source,E'begin\n',E'begin\n  if current_setting(''app.web_push_kicked'',true)=''1'' then return null; end if;\n');
  source:=replace(source,'  return request_id;',E'  perform set_config(''app.web_push_kicked'',''1'',true);\n  perform app.arm_delivery_push_retry();\n  return request_id;');
  execute source;
  source:=pg_get_functiondef('app.initialize_delivery_push(text,text,text)'::regprocedure);
  if position('delivery-task-web-push' in source)=0 then raise exception 'Unexpected push initializer definition';end if;
  source:=replace(source,'perform cron.schedule(''delivery-task-web-push'',''* * * * *'',''select app.kick_delivery_push();'');','perform app.kick_delivery_push();');
  execute source;
end $$;

create function app.wake_delivery_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  begin
    perform app.kick_delivery_push();
  exception when others then
    -- Dispatch transport must not roll back the user's inventory/task update.
    raise warning 'Push dispatch unavailable; pending events retained for retry';
  end;
  perform app.arm_delivery_push_retry();
  return null;
end;
$$;
create function app.rearm_delivery_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform app.arm_delivery_push_retry();
  return null;
end;
$$;
create trigger wake_delivery_push after insert on app.delivery_push_events
  for each statement execute function app.wake_delivery_push();
create trigger wake_admin_push after insert on app.admin_push_events
  for each statement execute function app.wake_delivery_push();
create trigger wake_push_subscription after insert or update of enabled on app.delivery_push_subscriptions
  for each statement execute function app.wake_delivery_push();
create trigger rearm_delivery_push after insert or update of state,next_attempt_at on app.delivery_push_deliveries
  for each statement execute function app.rearm_delivery_push();
create trigger rearm_admin_push after insert or update of state,next_attempt_at on app.admin_push_deliveries
  for each statement execute function app.rearm_delivery_push();

revoke all on function app.arm_delivery_push_retry(),app.retry_delivery_push(),app.wake_delivery_push(),app.rearm_delivery_push() from public,anon,authenticated;
grant execute on function app.arm_delivery_push_retry(),app.retry_delivery_push() to service_role;
select cron.unschedule(jobid) from cron.job where jobname='delivery-task-web-push';
select app.arm_delivery_push_retry();

-- Expired messages are already hidden by the read RPC. Physical cleanup is
-- maintenance, not notification delivery: hourly is sufficient.
select cron.schedule('marketplace-message-retention','17 * * * *','select app.purge_expired_marketplace_messages()');
