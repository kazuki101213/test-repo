-- Private, event-driven preparation. Existing LINE retry cron also drains this
-- queue; no new polling schedule or listing prerequisite is introduced.
create table app.line_photo_selections (
 item_id uuid primary key references app.items(id) on delete cascade,
 state text not null default 'pending' check(state in('pending','running','ready','unavailable','failed')),
 lease uuid, attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 source_snapshot jsonb, result jsonb, last_error text, updated_at timestamptz not null default now()
);
alter table app.line_photo_selections enable row level security;
revoke all on app.line_photo_selections from public,anon,authenticated;
grant all on app.line_photo_selections to service_role;
-- Intentionally no client access; this policy makes the service-only boundary explicit.
create policy line_photo_selections_service on app.line_photo_selections to service_role using(true) with check(true);
create index line_photo_selections_due on app.line_photo_selections(next_attempt_at) where state in('pending','running','failed');

create function app.enqueue_line_photo_selection(p_item uuid,p_changed boolean default false) returns void
language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from app.items where id=p_item and shipped_on is null and sold_on is null) then return;end if;
 if exists(select 1 from app.delivery_line_preferences where item_id=p_item and overview_photo_id is not null and model_photo_id is not null) then return;end if;
 insert into app.line_photo_selections(item_id) values(p_item) on conflict(item_id) do update
 set state='pending',lease=null,attempts=0,next_attempt_at=now()+interval '30 seconds',updated_at=now()
 where p_changed and app.line_photo_selections.state<>'running';
end $$;

create function app.capture_line_photo_selection() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if tg_table_name='item_photos' then
  if tg_op='DELETE' then
   if coalesce(old.photo_kind,'product')='product' then perform app.enqueue_line_photo_selection(old.item_id,true);end if;
  elsif coalesce(new.photo_kind,'product')='product' and new.storage_path not like '%/line-auto-%' then
   perform app.enqueue_line_photo_selection(new.item_id,true);
  end if;
 else
  if new.active and (tg_op='INSERT' or old.external_id is distinct from new.external_id or not old.active) then perform app.enqueue_line_photo_selection(new.item_id,true);end if;
 end if;
 return null;
end $$;
create trigger line_photo_selection_photos after insert or update of storage_path,photo_kind or delete on app.item_photos for each row execute function app.capture_line_photo_selection();
create trigger line_photo_selection_listing after insert or update of active,external_id on app.seller_listings for each row execute function app.capture_line_photo_selection();

create function app.claim_line_photo_selection(p_item uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q app.line_photo_selections;context jsonb;
begin
 -- Repair previously missed pending shipping requests, without replaying sent ones.
 if p_item is not null then perform app.enqueue_line_photo_selection(p_item);else
  perform app.enqueue_line_photo_selection(t.item_id) from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id
   where o.state='pending' and app.line_shipping_eligible(o.id) order by o.next_attempt_at limit 20;
 end if;
 select s.* into q from app.line_photo_selections s join app.items i on i.id=s.item_id
 where (p_item is null or s.item_id=p_item) and s.state in('pending','failed','running') and s.next_attempt_at<=now() and s.attempts<3
  and i.shipped_on is null and i.sold_on is null
 order by exists(select 1 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id where t.item_id=s.item_id and o.state='pending') desc,
  s.next_attempt_at limit 1 for update of s skip locked;
 if q.item_id is null then return null;end if;
 if exists(select 1 from app.delivery_line_preferences where item_id=q.item_id and overview_photo_id is not null and model_photo_id is not null) then
  update app.line_photo_selections set state='ready',last_error=null where item_id=q.item_id;return null;
 end if;
 select jsonb_build_object('itemId',i.id,'sku',i.sku,'model',p.model_no,
  'photos',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'path',v.storage_path) order by v.created_at,v.id)
   from(select id,storage_path,created_at from app.item_photos where item_id=i.id and coalesce(photo_kind,'product')='product'
    and storage_path ~* '\.(jpe?g|png)$' order by created_at,id limit 20)v),'[]'),
  'listing',(select jsonb_build_object('id',l.id,'channel',l.channel,'externalId',l.external_id) from app.seller_listings l
   where l.item_id=i.id and l.active and l.channel in('メルカリ','ヤフオク')
    and (i.seller_trade_key is null or l.trade_key=i.seller_trade_key) order by l.observed_at desc,l.id limit 1)) into context
 from app.items i left join app.products p on p.id=i.product_id where i.id=q.item_id;
 update app.line_photo_selections set state='running',lease=gen_random_uuid(),attempts=attempts+1,next_attempt_at=now()+interval '5 minutes',source_snapshot=context,updated_at=now()
 where item_id=q.item_id returning * into q;
 return context||jsonb_build_object('lease',q.lease);
end $$;

create function app.finish_line_photo_selection(p_item uuid,p_lease uuid,p_result jsonb,p_error text default null) returns boolean
language plpgsql security invoker set search_path='' as $$
declare q app.line_photo_selections;front uuid;model uuid;value jsonb;photo uuid;expected_path text;listing app.seller_listings;
begin
 select * into q from app.line_photo_selections where item_id=p_item and lease=p_lease and state='running' for update;
 if q.item_id is null then return false;end if;
 if p_error is not null then
  update app.line_photo_selections set state='failed',last_error=left(p_error,160),next_attempt_at=now()+interval '15 minutes',lease=null,updated_at=now() where item_id=p_item;return false;
 end if;
 if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>4000 then raise exception 'Invalid selection';end if;
 if jsonb_array_length(q.source_snapshot->'photos')>0 and exists(
  select 1 from app.item_photos p where p.item_id=p_item and coalesce(p.photo_kind,'product')='product'
   and p.storage_path ~* '\.(jpe?g|png)$' and not exists(select 1 from jsonb_array_elements(q.source_snapshot->'photos')v where v->>'id'=p.id::text)
 ) and jsonb_array_length(q.source_snapshot->'photos')<20 then
  update app.line_photo_selections set state='pending',lease=null,attempts=0,next_attempt_at=now()+interval '30 seconds' where item_id=p_item;return false;
 end if;
 -- Recheck listing identity and absence of app photos before importing the fallback.
 if jsonb_array_length(q.source_snapshot->'photos')=0 then
  select * into listing from app.seller_listings where id=(q.source_snapshot->'listing'->>'id')::uuid and item_id=p_item and active
   and external_id=q.source_snapshot->'listing'->>'externalId';
  if listing.id is null or exists(select 1 from app.item_photos where item_id=p_item and coalesce(photo_kind,'product')='product') then
   update app.line_photo_selections set state='pending',lease=null,next_attempt_at=now(),updated_at=now() where item_id=p_item;return false;
  end if;
 end if;
 foreach expected_path in array array['overview','model'] loop
  value:=p_result->expected_path;photo:=null;
  if value is not null and value<>'null'::jsonb then
   if jsonb_array_length(q.source_snapshot->'photos')>0 then
    select p.id into photo from app.item_photos p where p.item_id=p_item and coalesce(p.photo_kind,'product')='product'
     and p.id=(value->>'id')::uuid and exists(select 1 from jsonb_array_elements(q.source_snapshot->'photos')v where v->>'id'=p.id::text and v->>'path'=p.storage_path);
    if photo is null then update app.line_photo_selections set state='pending',lease=null,next_attempt_at=now() where item_id=p_item;return false;end if;
   else
    if value->>'path' is distinct from (q.source_snapshot->>'sku')||'/line-auto-'||listing.id::text||'-'||expected_path||'.jpg' then raise exception 'Invalid imported photo';end if;
    if not exists(select 1 from storage.objects where bucket_id='item-photos' and name=value->>'path') then raise exception 'Photo file missing';end if;
    insert into app.item_photos(item_id,storage_path,photo_kind) values(p_item,value->>'path','product') returning id into photo;
   end if;
  end if;
  if expected_path='overview' then front:=photo;else model:=photo;end if;
 end loop;
 -- Preserve manual choices and shipping, including a manual save during AI work.
 insert into app.delivery_line_preferences(item_id,overview_photo_id,model_photo_id) values(p_item,front,model)
 on conflict(item_id) do update set overview_photo_id=coalesce(app.delivery_line_preferences.overview_photo_id,excluded.overview_photo_id),
  model_photo_id=coalesce(app.delivery_line_preferences.model_photo_id,excluded.model_photo_id),updated_at=now();
 update app.line_photo_selections set state=case when front is not null and model is not null then 'ready' else 'unavailable' end,
  result=p_result,last_error=null,lease=null,updated_at=now() where item_id=p_item;
 return true;
end $$;

revoke all on function app.enqueue_line_photo_selection(uuid,boolean),app.capture_line_photo_selection(),app.claim_line_photo_selection(uuid),app.finish_line_photo_selection(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function app.enqueue_line_photo_selection(uuid,boolean),app.claim_line_photo_selection(uuid),app.finish_line_photo_selection(uuid,uuid,jsonb,text) to service_role;
-- Reuse the existing private dispatcher and its existing cron; no extra timer.
create or replace function app.kick_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text;project_url text;request_id bigint;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) or (
  not exists(select 1 from app.delivery_line_outbox o where state in('pending','sending') and next_attempt_at<=now() and attempts<5 and app.line_shipping_media(o.id) is not null)
  and not exists(select 1 from app.line_photo_selections q join app.items i on i.id=q.item_id where q.state in('pending','failed','running') and q.attempts<3 and q.next_attempt_at<=now()
   and i.shipped_on is null and i.sold_on is null
   and not exists(select 1 from app.delivery_line_preferences p where p.item_id=i.id and p.overview_photo_id is not null and p.model_photo_id is not null))
 ) then return null;end if;
 select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
 select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
 if dispatch_token is null or project_url is null then return null;end if;
 select net.http_post(url:=project_url||'/functions/v1/delivery-line',headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
 body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=50000) into request_id;return request_id;
end $$;
-- A deliberate resend uses the same automatic preparation, not a separate
-- manual-photo prerequisite. All trade, assignment and duplicate guards stay.
do $$declare source text;startpos integer;endpos integer;begin
 source:=pg_get_functiondef('app.request_delivery_line_resend(uuid)'::regprocedure);
 startpos:=strpos(source,' if not exists('||chr(10)||'  select 1 from app.delivery_line_preferences pref');
 if startpos=0 then raise exception 'Resend photo prerequisite changed';end if;
 endpos:=strpos(substring(source from startpos),'end if;')+startpos+length('end if;')-1;
 execute overlay(source placing ' perform app.enqueue_line_photo_selection(i.id);' from startpos for endpos-startpos);
end $$;
notify pgrst,'reload schema';
