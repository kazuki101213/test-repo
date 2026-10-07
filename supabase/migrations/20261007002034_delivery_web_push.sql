-- Future-only events; existing tasks are deliberately not backfilled.
create table app.delivery_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references app.staff(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  base_url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index delivery_push_subscriptions_staff_idx on app.delivery_push_subscriptions(staff_id);
create table app.delivery_push_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.items(id) on delete cascade,
  staff_id uuid not null references app.staff(id) on delete cascade,
  kind text not null check (kind in ('reply','photo','assigned')),
  event_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (item_id, staff_id, kind, event_at)
);
create index delivery_push_events_staff_idx on app.delivery_push_events(staff_id,created_at);
create table app.delivery_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references app.delivery_push_events(id) on delete cascade,
  subscription_id uuid not null references app.delivery_push_subscriptions(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','sending','sent','cancelled','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_status integer,
  unique(event_id,subscription_id)
);
create index delivery_push_deliveries_subscription_idx on app.delivery_push_deliveries(subscription_id);
create index delivery_push_deliveries_pending_idx on app.delivery_push_deliveries(next_attempt_at) where state in ('pending','sending');
alter table app.delivery_push_subscriptions enable row level security;
alter table app.delivery_push_events enable row level security;
alter table app.delivery_push_deliveries enable row level security;
revoke all on app.delivery_push_subscriptions,app.delivery_push_events,app.delivery_push_deliveries from public,anon,authenticated;
grant all on app.delivery_push_subscriptions,app.delivery_push_events,app.delivery_push_deliveries to service_role;

create function app.enqueue_delivery_push(p_item_id uuid,p_kind text,p_at timestamptz,p_actor uuid)
returns void language sql security definer set search_path='' as $$
  insert into app.delivery_push_events(item_id,staff_id,kind,event_at)
  select i.id,s.id,p_kind,p_at from app.items i join app.staff s
    on s.is_active and (s.role='admin' or (s.id=i.deliverer_id and s.role='deliverer'))
  where i.id=p_item_id and s.id is distinct from p_actor
  on conflict(item_id,staff_id,kind,event_at) do nothing;
$$;
revoke all on function app.enqueue_delivery_push(uuid,text,timestamptz,uuid) from public,anon,authenticated;

create function app.capture_delivery_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='item_comments' then
    if exists(select 1 from app.items i join app.staff s on s.id=new.author_id
      where i.id=new.item_id and i.malfunction_reported_at<new.created_at and s.role in ('admin','purchaser')) then
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
revoke all on function app.capture_delivery_push() from public,anon,authenticated;
create trigger item_comments_delivery_push after insert on app.item_comments for each row execute function app.capture_delivery_push();
create trigger photo_reviews_delivery_push after insert or update of approved_at on app.photo_reviews for each row execute function app.capture_delivery_push();
create trigger items_delivery_push after insert or update of deliverer_id on app.items for each row execute function app.capture_delivery_push();

-- Only the Edge Function's service client may read/store encrypted server keys.
create function app.delivery_push_config() returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(name,decrypted_secret),'{}'::jsonb) from vault.decrypted_secrets
  where name in ('delivery_push_vapid','delivery_push_public_key','delivery_push_dispatch_token','delivery_push_project_url');
$$;
create function app.initialize_delivery_push(p_vapid text,p_public_key text,p_project_url text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(1735907184);
  if exists(select 1 from vault.secrets where name='delivery_push_vapid') then
    perform cron.schedule('delivery-task-web-push','* * * * *','select app.kick_delivery_push();');
    return;
  end if;
  perform vault.create_secret(p_vapid,'delivery_push_vapid');
  perform vault.create_secret(p_public_key,'delivery_push_public_key');
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'delivery_push_dispatch_token');
  perform vault.create_secret(p_project_url,'delivery_push_project_url');
  perform cron.schedule('delivery-task-web-push','* * * * *','select app.kick_delivery_push();');
end;
$$;
revoke all on function app.delivery_push_config(),app.initialize_delivery_push(text,text,text) from public,anon,authenticated;
grant execute on function app.delivery_push_config(),app.initialize_delivery_push(text,text,text) to service_role;

create function app.claim_delivery_push() returns table(delivery_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text,base_url text,item_id uuid,lot_seq integer,kind text,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
  update app.delivery_push_deliveries set state='failed'
    where state='sending' and attempts>=5 and next_attempt_at<=now();
  insert into app.delivery_push_deliveries(event_id,subscription_id)
    select e.id,s.id from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.enabled and s.created_at<=e.created_at
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
    s.enabled and st.is_active and s.staff_id=e.staff_id and s.created_at<=e.created_at
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
create function app.finish_delivery_push(p_id uuid,p_state text,p_status integer) returns void
language sql security definer set search_path='' as $$
  update app.delivery_push_deliveries set
    state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
    sent_at=case when p_state='sent' then now() else sent_at end,
    last_status=p_status,next_attempt_at=now()+interval '1 minute'*greatest(1,attempts)
  where id=p_id and state='sending' and p_state in ('pending','sent','cancelled','failed');
$$;
revoke all on function app.claim_delivery_push(),app.finish_delivery_push(uuid,text,integer) from public,anon,authenticated;
grant execute on function app.claim_delivery_push(),app.finish_delivery_push(uuid,text,integer) to service_role;

create function app.kick_delivery_push() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text; project_url text; request_id bigint;
begin
  if not exists (
    select 1 from app.delivery_push_deliveries d where d.state in ('pending','sending') and d.next_attempt_at<=now() and (d.attempts<5 or d.state='sending')
  ) and not exists (
    select 1 from app.delivery_push_events e join app.delivery_push_subscriptions s
      on s.staff_id=e.staff_id and s.enabled and s.created_at<=e.created_at
    where e.created_at>now()-interval '24 hours' and not exists (
      select 1 from app.delivery_push_deliveries d where d.event_id=e.id and d.subscription_id=s.id)
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
revoke all on function app.kick_delivery_push() from public,anon,authenticated;
grant execute on function app.kick_delivery_push() to service_role;
-- Scheduling is performed on the production project after initializing Vault.
