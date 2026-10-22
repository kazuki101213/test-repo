-- Manual purchase history sync requests: authenticated active administrators only.
create table app.purchase_sync_requests (
 request_id uuid not null, profile_id uuid not null, owner_id uuid not null,
 accounts jsonb not null check(jsonb_typeof(accounts)='array'),
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 claim_token uuid, result jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 minutes',
 finished_at timestamptz,
 primary key(request_id,profile_id)
);
create index purchase_sync_requests_owner_latest on app.purchase_sync_requests(owner_id,created_at desc);
alter table app.purchase_sync_requests enable row level security;
revoke all on app.purchase_sync_requests from public,anon,authenticated;
grant select,insert,update on app.purchase_sync_requests to authenticated;
create policy purchase_sync_owner_admin on app.purchase_sync_requests for all to authenticated
 using(owner_id=(select auth.uid()) and (select app.is_admin()) and exists(select 1 from app.staff where id=app.current_staff_id() and is_active))
 with check(owner_id=(select auth.uid()) and (select app.is_admin()) and exists(select 1 from app.staff where id=app.current_staff_id() and is_active));
create function app.purchase_sync(p_action text,p_request_id uuid default null,p_profile_id uuid default null,p_claim_token uuid default null,p_result jsonb default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare target uuid; claimed app.purchase_sync_requests; expected text[]:=array['mercari-1','mercari-2','auctions-1','auctions-2','flea-1','flea-2','rakuma-1']; ids text[]; total integer;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者としてログインしてください' using errcode='42501';end if;
 if p_action='request' then
  if p_request_id is null then raise exception '同期依頼IDが必要です';end if;
  perform pg_advisory_xact_lock(hashtextextended('purchase-sync:'||auth.uid()::text,0));
  select request_id into target from app.purchase_sync_requests where owner_id=auth.uid() and (request_id=p_request_id or (status in ('queued','running') and expires_at>now())) order by created_at desc limit 1;
  if target is null then
   select array_agg(distinct a order by a),count(*) into ids,total from app.marketplace_extension_runtime_status r cross join lateral jsonb_array_elements_text(r.accounts) a
    where r.mode<>'diagnostic' and r.reported_at>now()-interval '7 days' and r.accounts<@to_jsonb(expected);
   if total<>7 or cardinality(ids)<>7 or not ids@>expected then raise exception '7アカウントの拡張機能登録を確認できません。別PCのChromeを開いてください';end if;
   insert into app.purchase_sync_requests(request_id,profile_id,owner_id,accounts)
    select p_request_id,r.profile_id,auth.uid(),r.accounts from app.marketplace_extension_runtime_status r
    where r.mode<>'diagnostic' and r.reported_at>now()-interval '7 days' and r.accounts<@to_jsonb(expected) and jsonb_array_length(r.accounts)>0;
   target:=p_request_id;
  end if;
 elsif p_action='claim' then
  if p_profile_id is null then raise exception '実行プロファイルが必要です';end if;
  select * into claimed from app.purchase_sync_requests where owner_id=auth.uid() and profile_id=p_profile_id and status='queued' and expires_at>now() order by created_at limit 1 for update skip locked;
  if not found then return null;end if;
  update app.purchase_sync_requests set status='running',claim_token=gen_random_uuid() where request_id=claimed.request_id and profile_id=p_profile_id returning * into claimed;
  return jsonb_build_object('requestId',claimed.request_id,'profileId',claimed.profile_id,'accounts',claimed.accounts,'token',claimed.claim_token,'expiresAt',claimed.expires_at);
 elsif p_action='finish' then
  if p_request_id is null or p_profile_id is null or p_claim_token is null or jsonb_typeof(p_result)<>'object' or p_result is null then raise exception '完了記録を確認してください';end if;
  if coalesce(p_result->>'imported','0') !~ '^[0-9]{1,7}$' or coalesce(p_result->>'errors','0') !~ '^[0-9]{1,7}$' then raise exception '件数が不正です';end if;
  update app.purchase_sync_requests set status=case when coalesce((p_result->>'errors')::integer,0)>0 then 'failed' else 'completed' end,
   result=jsonb_build_object('imported',coalesce((p_result->>'imported')::integer,0),'errors',coalesce((p_result->>'errors')::integer,0),'note',left(coalesce(p_result->>'note',''),500)),finished_at=now()
   where owner_id=auth.uid() and request_id=p_request_id and profile_id=p_profile_id and claim_token=p_claim_token and status='running';
  if not found and not exists(select 1 from app.purchase_sync_requests where owner_id=auth.uid() and request_id=p_request_id and profile_id=p_profile_id and claim_token=p_claim_token and status in ('completed','failed')) then raise exception '同期の予約が一致しません';end if;
  target:=p_request_id;
 elsif p_action='status' then
  target:=p_request_id;
  if target is null then select request_id into target from app.purchase_sync_requests where owner_id=auth.uid() order by created_at desc limit 1;end if;
 else raise exception '同期操作が不正です';end if;
 return jsonb_build_object('requestId',target,'profiles',coalesce((select jsonb_agg(jsonb_build_object('profileId',profile_id,'accounts',accounts,'status',case when status in ('queued','running') and expires_at<=now() then 'expired' else status end,'result',result,'createdAt',created_at,'expiresAt',expires_at,'finishedAt',finished_at) order by profile_id) from app.purchase_sync_requests where owner_id=auth.uid() and request_id=target),'[]'::jsonb));
end $$;
revoke all on function app.purchase_sync(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app.purchase_sync(text,uuid,uuid,uuid,jsonb) to authenticated;
