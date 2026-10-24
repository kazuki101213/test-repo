-- Disposable database only; every fixture and scheduler stub is rolled back.
begin;
alter table cron.job add column schedule text;
alter table cron.job add column command text;
create or replace function cron.schedule(text,text,text) returns bigint language plpgsql as $$
begin
 delete from cron.job where jobname=$1;
 insert into cron.job(jobid,jobname,schedule,command) values(999001,$1,$2,$3);
 return 999001;
end $$;
create or replace function cron.unschedule(bigint) returns boolean language plpgsql as $$
begin delete from cron.job where jobid=$1;return true;end $$;
create schema if not exists net;
create temporary table push_http_calls(id bigint generated always as identity);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
returns bigint language plpgsql as $$declare n bigint;begin
 insert into push_http_calls default values returning id into n;return n;
end $$;
insert into vault.secrets(name,secret) values('delivery_push_dispatch_token','fixture'),('delivery_push_project_url','https://fixture.invalid');
select app.arm_delivery_push_retry();
do $$begin
 if exists(select 1 from cron.job where jobname in('delivery-task-web-push','delivery-push-retry')) then raise exception 'Idle queue scheduled polling';end if;
end $$;
insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind)
 select id,'https://web.push.apple.com/idle-fixture','fixture','fixture','https://bussan-admin.vercel.app/',now()-interval '1 day','admin'
 from app.staff where code='AA';
insert into app.admin_push_events(staff_id,kind,source_id,event_at,source_key)
 select id,'action',gen_random_uuid(),now(),'idle-fixture-'||n from app.staff cross join generate_series(1,2) n where code='AA';
do $$begin
 if (select count(*) from push_http_calls)<>1 then raise exception 'New events did not dispatch once';end if;
 if not exists(select 1 from cron.job where jobname='delivery-push-retry' and schedule<>'* * * * *') then raise exception 'Transport watchdog missing';end if;
 perform app.kick_delivery_push();
 if (select count(*) from push_http_calls)<>1 then raise exception 'Transaction sent duplicate dispatch';end if;
end $$;
insert into app.admin_push_deliveries(event_id,subscription_id,state,attempts,next_attempt_at)
 select e.id,s.id,'sending',1,now()+interval '5 minutes' from app.admin_push_events e
 join app.delivery_push_subscriptions s on s.staff_id=e.staff_id where e.source_key like 'idle-fixture-%';
select app.finish_admin_push(d.id,'pending',503) from app.admin_push_deliveries d;
do $$begin
 if not exists(select 1 from cron.job where jobname='delivery-push-retry') then raise exception 'Retry was lost';end if;
end $$;
update app.admin_push_deliveries set state='sent';
do $$begin
 if exists(select 1 from cron.job where jobname='delivery-push-retry') then raise exception 'Completed queue kept polling';end if;
 perform set_config('app.web_push_kicked','',true);
 perform app.retry_delivery_push();
 if (select count(*) from push_http_calls)<>1 then raise exception 'Empty watchdog called HTTP';end if;
 if has_function_privilege('anon','app.retry_delivery_push()','execute') or has_function_privilege('authenticated','app.arm_delivery_push_retry()','execute') then raise exception 'Private dispatcher exposed';end if;
 if position('delivery-task-web-push' in pg_get_functiondef('app.initialize_delivery_push(text,text,text)'::regprocedure))>0 then raise exception 'Setup recreates minute cron';end if;
end $$;
-- Expired work cannot keep a retry alarm alive.
update app.admin_push_events set created_at=now()-interval '25 hours' where source_key like 'idle-fixture-%';
update app.admin_push_deliveries set state='pending';
select app.retry_delivery_push();
do $$begin
 if exists(select 1 from cron.job where jobname='delivery-push-retry') or exists(select 1 from app.admin_push_deliveries where state='pending') then raise exception 'Expired work still retries';end if;
end $$;
rollback;
