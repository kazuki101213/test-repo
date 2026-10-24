-- LINE identifiers and one-time link codes are never exposed through Data API.
create table app.delivery_line_links (
 id uuid not null unique default gen_random_uuid(),
 staff_id uuid primary key references app.staff(id) on delete cascade,
 line_user_id text not null unique check(line_user_id ~ '^U[0-9a-f]{32}$'),
 linked_at timestamptz not null default now(),blocked boolean not null default false
);
create table app.delivery_line_codes (
 staff_id uuid primary key references app.staff(id) on delete cascade,
 code_hash text not null unique check(code_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),expires_at timestamptz not null
);
create table app.delivery_line_webhooks (
 event_id text primary key,created_at timestamptz not null default now()
);
create table app.delivery_line_settings (
 singleton boolean primary key default true check(singleton),enabled boolean not null default false
);
insert into app.delivery_line_settings default values;
create table app.delivery_line_outbox (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references app.delivery_shipping_tasks(id) on delete cascade,
 link_id uuid not null references app.delivery_line_links(id) on delete cascade,
 trade_key text,
 created_at timestamptz not null default now(),
 state text not null default 'pending' check(state in ('pending','sending','sent','cancelled','failed')),
 attempts integer not null default 0,next_attempt_at timestamptz not null default now(),
 first_attempt_at timestamptz,sent_at timestamptz,last_status integer,lease uuid,
 payload jsonb,unique(task_id,link_id)
);
create index delivery_line_outbox_pending on app.delivery_line_outbox(next_attempt_at) where state in ('pending','sending');
create index delivery_line_outbox_link on app.delivery_line_outbox(link_id);
alter table app.delivery_line_links enable row level security;
alter table app.delivery_line_codes enable row level security;
alter table app.delivery_line_webhooks enable row level security;
alter table app.delivery_line_settings enable row level security;
alter table app.delivery_line_outbox enable row level security;
revoke all on app.delivery_line_links,app.delivery_line_codes,app.delivery_line_webhooks,app.delivery_line_settings,app.delivery_line_outbox from public,anon,authenticated;
grant all on app.delivery_line_links,app.delivery_line_codes,app.delivery_line_webhooks,app.delivery_line_settings,app.delivery_line_outbox to service_role;

-- Service-only RPCs: the Edge Function validates Auth.getUser and active staff.
-- Atomic issuance prevents concurrent requests from bypassing the per-staff limit.
create function app.issue_delivery_line_code(p_staff uuid,p_hash text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_staff::text,17351));
 if not exists(select 1 from app.staff where id=p_staff and is_active and role in ('admin','deliverer')) then raise exception 'Invalid staff';end if;
 if exists(select 1 from app.delivery_line_codes where staff_id=p_staff and created_at>now()-interval '1 minute') then raise exception 'Please wait one minute';end if;
 insert into app.delivery_line_codes(staff_id,code_hash,expires_at) values(p_staff,p_hash,now()+interval '10 minutes')
 on conflict(staff_id) do update set code_hash=excluded.code_hash,created_at=now(),expires_at=excluded.expires_at;
end $$;

-- Serialize link/unfollow operations. Replayed webhook events cannot consume a
-- fresh code or replace a later binding. Never transfer another staff's LINE.
create function app.handle_delivery_line_event(p_event text,p_kind text,p_user text,p_hash text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
 perform pg_advisory_xact_lock(173511019);
 if p_user !~ '^U[0-9a-f]{32}$' or length(p_event)>128 or p_kind not in ('link','unfollow') then return false;end if;
 insert into app.delivery_line_webhooks(event_id) values(p_event) on conflict do nothing;
 if not found then return false;end if;
 delete from app.delivery_line_webhooks where created_at<now()-interval '7 days';
 delete from app.delivery_line_codes where expires_at<now();
 if p_kind='unfollow' then
  update app.delivery_line_links set blocked=true where line_user_id=p_user;
  update app.delivery_line_outbox o set state='cancelled' from app.delivery_line_links l
   where o.link_id=l.id and l.line_user_id=p_user and o.state in ('pending','sending');
  return false;
 end if;
 select c.staff_id into target from app.delivery_line_codes c join app.staff s on s.id=c.staff_id
  where c.code_hash=p_hash and c.expires_at>now() and s.is_active and s.role in ('admin','deliverer') for update of c;
 if target is null or exists(select 1 from app.delivery_line_links where line_user_id=p_user and staff_id<>target) then return false;end if;
 -- A new generation cancels old pending messages, including retries to an old LINE.
 delete from app.delivery_line_links where staff_id=target;
 insert into app.delivery_line_links(staff_id,line_user_id) values(target,p_user);
 delete from app.delivery_line_codes where staff_id=target;
 return true;
end $$;

create function app.unlink_delivery_line(p_staff uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(173511019);
 delete from app.delivery_line_codes where staff_id=p_staff;
 delete from app.delivery_line_links where staff_id=p_staff;
end $$;

-- Only future tasks and actual staff reassignment enqueue. Registration does not
-- broadcast historical requests. No marketplace polling is added.
create function app.capture_delivery_line_shipping() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='delivery_shipping_tasks' then
  insert into app.delivery_line_outbox(task_id,link_id,trade_key)
  select new.id,l.id,i.seller_trade_key from app.items i join app.delivery_line_links l on l.staff_id=i.deliverer_id
  join app.staff s on s.id=l.staff_id and s.is_active
  where i.id=new.item_id and not l.blocked and new.resolved_at is null
   and (select enabled from app.delivery_line_settings where singleton)
  on conflict do nothing;
 elsif new.deliverer_id is distinct from old.deliverer_id then
  insert into app.delivery_line_outbox(task_id,link_id,trade_key)
  select t.id,l.id,new.seller_trade_key from app.delivery_shipping_tasks t
   join app.delivery_line_links l on l.staff_id=new.deliverer_id and not l.blocked
   join app.staff s on s.id=l.staff_id and s.is_active
  where t.item_id=new.id and t.resolved_at is null and (select enabled from app.delivery_line_settings where singleton)
  on conflict do nothing;
 end if;
 return new;
end $$;
create trigger delivery_shipping_tasks_line after insert on app.delivery_shipping_tasks for each row execute function app.capture_delivery_line_shipping();
create trigger items_line_reassignment after update of deliverer_id on app.items for each row execute function app.capture_delivery_line_shipping();

create function app.claim_delivery_line() returns table(id uuid,lease uuid,recipient text,payload jsonb,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return;end if;
 update app.delivery_line_outbox o set state='failed' where o.state in ('pending','sending')
  and o.next_attempt_at<=now() and (o.attempts>=5 or o.created_at<now()-interval '23 hours');
 return query with ready as (
  select o.id from app.delivery_line_outbox o where o.state in ('pending','sending')
   and o.next_attempt_at<=now() and o.attempts<5 and o.created_at>now()-interval '23 hours'
  order by o.next_attempt_at limit 5 for update skip locked
 ), claimed as (
  update app.delivery_line_outbox o set state='sending',attempts=o.attempts+1,
   first_attempt_at=coalesce(o.first_attempt_at,now()),next_attempt_at=now()+interval '5 minutes',lease=gen_random_uuid(),
   payload=coalesce(o.payload,jsonb_build_object('itemId',i.id,'sku',i.sku,'serial',split_part(i.sku,'-',1)))
  from ready r,app.delivery_shipping_tasks t,app.items i where o.id=r.id and t.id=o.task_id and i.id=t.item_id returning o.*
 ) select o.id,o.lease,l.line_user_id,o.payload,
  not l.blocked and s.is_active and s.id=i.deliverer_id and l.linked_at<=o.created_at
  and t.resolved_at is null and i.status='取引中' and i.shipped_on is null
  and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
  and i.seller_trade_key is not distinct from o.trade_key
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=s.id and c.item_id=i.id and c.notice_id='shipping:'||t.id::text)
 from claimed o join app.delivery_line_links l on l.id=o.link_id join app.staff s on s.id=l.staff_id
 join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id;
end $$;
create function app.finish_delivery_line(p_id uuid,p_lease uuid,p_state text,p_status integer) returns void
language sql security definer set search_path='' as $$
 update app.delivery_line_outbox set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
 last_status=p_status,sent_at=case when p_state='sent' then now() else sent_at end,next_attempt_at=now()+interval '5 minutes'
 where id=p_id and lease=p_lease and state='sending' and p_state in ('pending','sent','cancelled','failed');
$$;
-- Reuse the existing private dispatcher token. No network request when no queue.
create function app.kick_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text;project_url text;request_id bigint;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) or not exists(
  select 1 from app.delivery_line_outbox where state in ('pending','sending') and next_attempt_at<=now()
 ) then return null;end if;
 select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
 select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
 if dispatch_token is null or project_url is null then return null;end if;
 select net.http_post(url:=project_url||'/functions/v1/delivery-line',
  headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
  body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=50000) into request_id;
 return request_id;
end $$;
revoke all on function app.issue_delivery_line_code(uuid,text),app.handle_delivery_line_event(text,text,text,text),app.capture_delivery_line_shipping(),app.claim_delivery_line(),app.finish_delivery_line(uuid,uuid,text,integer),app.kick_delivery_line() from public,anon,authenticated;
grant execute on function app.issue_delivery_line_code(uuid,text),app.handle_delivery_line_event(text,text,text,text),app.claim_delivery_line(),app.finish_delivery_line(uuid,uuid,text,integer),app.kick_delivery_line() to service_role;
revoke all on function app.unlink_delivery_line(uuid) from public,anon,authenticated;
grant execute on function app.unlink_delivery_line(uuid) to service_role;
select cron.schedule('delivery-line-shipping','* * * * *','select app.kick_delivery_line();');
notify pgrst,'reload schema';
