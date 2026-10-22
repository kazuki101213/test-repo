create table app.listing_ai_keywords (
 item_id uuid not null references app.items(id) on delete cascade,
 fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
 keywords text not null default '',
 claim_id uuid not null default gen_random_uuid(),
 actor_id uuid not null references auth.users(id),
 state text not null check (state in ('pending','ready','failed')),
 attempted_at timestamptz not null default now(),
 primary key(item_id,fingerprint)
);
alter table app.listing_ai_keywords enable row level security;
revoke all on app.listing_ai_keywords from public,anon,authenticated;
grant select,insert,update on app.listing_ai_keywords to service_role;
create index listing_ai_keywords_attempted on app.listing_ai_keywords(attempted_at);

create table app.listing_ai_attempts (
 claim_id uuid primary key,
 actor_id uuid not null references auth.users(id),
 attempted_at timestamptz not null default now()
);
alter table app.listing_ai_attempts enable row level security;
revoke all on app.listing_ai_attempts from public,anon,authenticated;
grant select,insert,delete on app.listing_ai_attempts to service_role;
create index listing_ai_attempts_time on app.listing_ai_attempts(attempted_at);

-- Only the Edge Function may claim; it validates Auth.getUser and item assignment first.
-- A global advisory lock makes the quota and per-input claim atomic across instances.
create function app.claim_listing_ai_keywords(p_item uuid,p_fingerprint text,p_actor uuid,p_force boolean default false)
returns jsonb language plpgsql security invoker set search_path=app,pg_temp as $$
declare row app.listing_ai_keywords; token uuid; history jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('app.listing_ai_keywords'));
 select * into row from app.listing_ai_keywords where item_id=p_item and fingerprint=p_fingerprint;
 select coalesce(jsonb_agg(keywords),'[]'::jsonb) into history from (
   select keywords from app.listing_ai_keywords where item_id=p_item and keywords<>'' order by attempted_at desc limit 20
 ) h;
 if row.state='ready' and not p_force then return jsonb_build_object('keywords',row.keywords,'previous',history,'cached',true); end if;
 if row.attempted_at>now()-interval '45 seconds' and (row.state<>'ready' or p_force) then
   return jsonb_build_object('wait',true);
 end if;
 if (select count(*) from app.listing_ai_attempts where attempted_at>now()-interval '1 hour' and actor_id=p_actor)>=20
 or (select count(*) from app.listing_ai_attempts where attempted_at>now()-interval '1 day')>=100 then
   return jsonb_build_object('limited',true);
 end if;
 token:=gen_random_uuid();
 delete from app.listing_ai_attempts where attempted_at<now()-interval '30 days';
 insert into app.listing_ai_attempts(claim_id,actor_id) values(token,p_actor);
 insert into app.listing_ai_keywords(item_id,fingerprint,actor_id,state,claim_id)
 values(p_item,p_fingerprint,p_actor,'pending',token)
 on conflict(item_id,fingerprint) do update set actor_id=p_actor,state='pending',claim_id=token,attempted_at=now();
 return jsonb_build_object('claim',token,'previous',history);
end $$;
revoke all on function app.claim_listing_ai_keywords(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function app.claim_listing_ai_keywords(uuid,text,uuid,boolean) to service_role;
