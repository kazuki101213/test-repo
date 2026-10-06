alter table app.items add column if not exists packed_completed_at timestamptz;
update app.items set packed_completed_at=((packed_on + 1)::timestamp at time zone 'Asia/Tokyo' - interval '1 microsecond') where packed_on is not null and packed_completed_at is null;
create or replace function app.capture_packed_completion_time() returns trigger language plpgsql set search_path='' as $$
begin
 if new.packed_on is null then new.packed_completed_at:=null;
 elsif tg_op='INSERT' then new.packed_completed_at:=clock_timestamp();
 elsif old.packed_on is null or old.packed_completed_at is null then new.packed_completed_at:=clock_timestamp();
 else new.packed_completed_at:=old.packed_completed_at; end if;
 return new;
end; $$;
drop trigger if exists items_capture_packed_completion_time on app.items;
create trigger items_capture_packed_completion_time before insert or update of packed_on on app.items for each row execute function app.capture_packed_completion_time();
create index if not exists items_packed_completed_at_idx on app.items(packed_completed_at) where packed_completed_at is not null;

create table if not exists app.marketplace_message_sync_requests (
 id uuid primary key default gen_random_uuid(), item_id uuid not null references app.items(id) on delete cascade,
 marketplace text not null, marketplace_item_id text not null, requested_by uuid not null references auth.users(id),
 status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
 requested_at timestamptz not null default now(), claimed_at timestamptz, claimed_by text, completed_at timestamptz, result_note text
);
create unique index if not exists marketplace_message_sync_active_item_idx on app.marketplace_message_sync_requests(item_id) where status in ('queued','processing');
create index if not exists marketplace_message_sync_queue_idx on app.marketplace_message_sync_requests(status,requested_at);
alter table app.marketplace_message_sync_requests enable row level security;
revoke all on app.marketplace_message_sync_requests from anon,authenticated;
grant select,insert,update on app.marketplace_message_sync_requests to authenticated;
drop policy if exists marketplace_message_sync_read on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_read on app.marketplace_message_sync_requests for select to authenticated using (requested_by=auth.uid() or app.is_admin() or app.current_role()='purchaser');
drop policy if exists marketplace_message_sync_insert on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_insert on app.marketplace_message_sync_requests for insert to authenticated with check (requested_by=auth.uid() and exists(select 1 from app.items i where i.id=app.marketplace_message_sync_requests.item_id and i.marketplace::text=app.marketplace_message_sync_requests.marketplace and i.marketplace_item_id=app.marketplace_message_sync_requests.marketplace_item_id and (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_message_sync_admin_update on app.marketplace_message_sync_requests;
create policy marketplace_message_sync_admin_update on app.marketplace_message_sync_requests for all to authenticated using (app.is_admin()) with check (app.is_admin());

create or replace function app.read_marketplace_messages(p_item_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare first_sent timestamptz; packed_at timestamptz;
begin
 if not exists(select 1 from app.items i where i.id=p_item_id and (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id()))
 then raise exception 'この商品の取引メッセージを表示する権限がありません' using errcode='42501'; end if;
 select min(o.sent_at) into first_sent from app.marketplace_message_outbox o where o.item_id=p_item_id and o.status='sent' and o.sent_at is not null;
 select i.packed_completed_at into packed_at from app.items i where i.id=p_item_id;
 if packed_at is not null and packed_at<=now()-interval '7 days' then
  return jsonb_build_object('messages','[]'::jsonb,'outbox','[]'::jsonb,'first_app_sent_at',first_sent,'sync',null,'expired',true);
 end if;
 return jsonb_build_object(
  'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author',m.author,'author_role',m.author_role,'body',m.body,'sent_at',m.sent_at) order by m.sent_at,m.id)
   from app.marketplace_messages m where m.item_id=p_item_id and first_sent is not null and m.author_role='other' and m.sent_at>=first_sent),'[]'::jsonb),
  'outbox',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'body',o.body,'status',o.status,'requested_at',o.requested_at,'sent_at',o.sent_at,'result_note',o.result_note) order by o.requested_at)
   from app.marketplace_message_outbox o where o.item_id=p_item_id and o.requested_by=auth.uid()),'[]'::jsonb),
  'first_app_sent_at',first_sent,
  'sync',(select jsonb_build_object('id',r.id,'status',r.status,'requested_at',r.requested_at,'completed_at',r.completed_at,'result_note',r.result_note) from app.marketplace_message_sync_requests r where r.item_id=p_item_id and r.requested_by=auth.uid() order by r.requested_at desc limit 1),
  'expired',false);
end; $$;

create or replace function app.queue_marketplace_message_sync(p_item_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_item app.items%rowtype; first_sent timestamptz; request_id uuid;
begin
 select * into v_item from app.items where id=p_item_id;
 if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then raise exception 'この商品の取引メッセージを確認する権限がありません' using errcode='42501'; end if;
 if nullif(btrim(v_item.marketplace_item_id),'') is null then raise exception '取引IDが登録されていません'; end if;
 if v_item.marketplace::text not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception 'この仕入先は取引メッセージ連携の対象外です'; end if;
 if v_item.packed_completed_at is not null and v_item.packed_completed_at<=now()-interval '7 days' then raise exception '梱包完了から7日を過ぎているため、メッセージを確認できません'; end if;
 select min(sent_at) into first_sent from app.marketplace_message_outbox where item_id=p_item_id and status='sent' and sent_at is not null;
 if first_sent is null then raise exception '先にアプリから取引メッセージを送信してください'; end if;
 insert into app.marketplace_message_sync_requests(item_id,marketplace,marketplace_item_id,requested_by) values(p_item_id,v_item.marketplace::text,v_item.marketplace_item_id,auth.uid())
 on conflict(item_id) where status in ('queued','processing') do nothing returning id into request_id;
 if request_id is null then select id into request_id from app.marketplace_message_sync_requests where item_id=p_item_id and status in ('queued','processing') order by requested_at desc limit 1; end if;
 return request_id;
end; $$;

create or replace function app.extension_marketplace_message_sync_queue(p_marketplaces text[])
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'item_id',r.item_id,'marketplace',r.marketplace,'marketplace_item_id',r.marketplace_item_id) order by r.requested_at)
  from app.marketplace_message_sync_requests r join app.items i on i.id=r.item_id where (r.status='queued' or (r.status='processing' and r.claimed_at<now()-interval '10 minutes')) and r.marketplace=any(p_marketplaces)
   and (i.packed_completed_at is null or i.packed_completed_at>now()-interval '7 days')),'[]'::jsonb);
end; $$;
create or replace function app.extension_claim_marketplace_message_sync(p_id uuid,p_claimant text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 update app.marketplace_message_sync_requests set status='processing',claimed_at=now(),claimed_by=left(coalesce(p_claimant,''),120),result_note=null
 where id=p_id and (status='queued' or (status='processing' and claimed_at<now()-interval '10 minutes'));
 get diagnostics changed=row_count; return changed=1;
end; $$;
create or replace function app.extension_finish_marketplace_message_sync(p_id uuid,p_status text,p_note text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 if p_status not in ('completed','failed') then raise exception '同期結果が不正です'; end if;
 update app.marketplace_message_sync_requests set status=p_status,completed_at=now(),result_note=left(p_note,500) where id=p_id and status='processing';
 get diagnostics changed=row_count; return changed=1;
end; $$;

create or replace function app.extension_sync_marketplace_messages(p_marketplace text,p_item_id text,p_account_label text,p_messages jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare linked_id uuid; affected integer; matched integer; first_sent timestamptz;
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or length(p_item_id)>160 then raise exception '取引を特定できません'; end if;
 select count(*) into matched from app.items where marketplace_item_id=p_item_id and (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ'));
 if matched>1 then raise exception '同じ取引IDの商品が複数あり、メッセージを結び付けられません'; end if;
 if matched=1 then select id into linked_id from app.items where marketplace_item_id=p_item_id and (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ')); end if;
 if linked_id is null then raise exception 'アプリの在庫行に一致しません'; end if;
 select min(sent_at) into first_sent from app.marketplace_message_outbox where item_id=linked_id and status='sent' and sent_at is not null;
 if first_sent is null then raise exception 'アプリからの送信成功後だけ相手のメッセージを取り込めます'; end if;
 if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>500 then raise exception '取引メッセージの形式が不正です'; end if;
 insert into app.marketplace_messages(marketplace,marketplace_item_id,item_id,external_id,author,author_role,body,sent_at)
 select p_marketplace,p_item_id,linked_id,entry->>'external_id',nullif(left(entry->>'author',200),''),'other',left(entry->>'body',10000),nullif(entry->>'sent_at','')::timestamptz
 from jsonb_array_elements(p_messages) entry where coalesce(entry->>'external_id','')<>'' and coalesce(entry->>'body','')<>''
  and entry->>'author_role'='other' and nullif(entry->>'sent_at','')::timestamptz>=first_sent
 on conflict(marketplace,marketplace_item_id,external_id) do update set item_id=excluded.item_id,author=excluded.author,author_role=excluded.author_role,body=excluded.body,sent_at=coalesce(excluded.sent_at,app.marketplace_messages.sent_at),synced_at=now();
 get diagnostics affected=row_count; return affected;
end; $$;

create or replace function app.purge_expired_marketplace_messages()
returns void language plpgsql security definer set search_path='' as $$
begin
 delete from app.marketplace_messages m using app.items i where m.item_id=i.id and i.packed_completed_at is not null and i.packed_completed_at<=now()-interval '7 days';
 delete from app.marketplace_message_outbox o using app.items i where o.item_id=i.id and i.packed_completed_at is not null and i.packed_completed_at<=now()-interval '7 days';
 delete from app.marketplace_message_sync_requests r using app.items i where r.item_id=i.id and i.packed_completed_at is not null and i.packed_completed_at<=now()-interval '7 days';
end; $$;
revoke all on function app.purge_expired_marketplace_messages() from public,anon,authenticated;
grant execute on function app.purge_expired_marketplace_messages() to postgres;
create extension if not exists pg_cron with schema pg_catalog;
do $$ declare existing_job bigint; begin
 select jobid into existing_job from cron.job where jobname='marketplace-message-retention';
 if existing_job is not null then perform cron.unschedule(existing_job); end if;
 perform cron.schedule('marketplace-message-retention','*/15 * * * *','select app.purge_expired_marketplace_messages()');
end; $$;

grant execute on function app.read_marketplace_messages(uuid) to authenticated;
grant execute on function app.queue_marketplace_message_sync(uuid) to authenticated;
grant execute on function app.extension_marketplace_message_sync_queue(text[]) to authenticated;
grant execute on function app.extension_claim_marketplace_message_sync(uuid,text) to authenticated;
grant execute on function app.extension_finish_marketplace_message_sync(uuid,text,text) to authenticated;
grant execute on function app.extension_sync_marketplace_messages(text,text,text,jsonb) to authenticated;

