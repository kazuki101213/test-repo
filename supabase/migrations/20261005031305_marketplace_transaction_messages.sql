create table if not exists app.marketplace_messages (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  marketplace_item_id text not null,
  item_id uuid references app.items(id) on delete cascade,
  external_id text not null,
  author text,
  author_role text not null default 'unknown' check (author_role in ('self','other','unknown')),
  body text not null check (length(body) between 1 and 10000),
  sent_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (marketplace, marketplace_item_id, external_id)
);
create index if not exists marketplace_messages_thread_idx
  on app.marketplace_messages(item_id, sent_at, id);
alter table app.marketplace_messages enable row level security;
revoke all on app.marketplace_messages from anon, authenticated;
grant select, insert, update on app.marketplace_messages to authenticated;
drop policy if exists marketplace_messages_read on app.marketplace_messages;
create policy marketplace_messages_read on app.marketplace_messages for select to authenticated
using (exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_messages_admin_write on app.marketplace_messages;
create policy marketplace_messages_admin_write on app.marketplace_messages for all to authenticated
using (app.is_admin()) with check (app.is_admin());

create table if not exists app.marketplace_message_outbox (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.items(id) on delete cascade,
  marketplace text not null,
  marketplace_item_id text not null,
  body text not null check (length(body) between 1 and 2000),
  requested_by uuid not null references auth.users(id),
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','uncertain')),
  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  sent_at timestamptz,
  result_note text
);
create index if not exists marketplace_message_outbox_queue_idx
  on app.marketplace_message_outbox(status, requested_at);
alter table app.marketplace_message_outbox enable row level security;
revoke all on app.marketplace_message_outbox from anon, authenticated;
grant select, insert, update on app.marketplace_message_outbox to authenticated;
drop policy if exists marketplace_message_outbox_read on app.marketplace_message_outbox;
create policy marketplace_message_outbox_read on app.marketplace_message_outbox for select to authenticated
using (requested_by=auth.uid() or app.is_admin() or app.current_role()='purchaser');
drop policy if exists marketplace_message_outbox_insert on app.marketplace_message_outbox;
create policy marketplace_message_outbox_insert on app.marketplace_message_outbox for insert to authenticated
with check (requested_by=auth.uid() and exists(select 1 from app.items i where i.id=item_id and
  (app.is_admin() or app.current_role()='purchaser' or i.deliverer_id=app.current_staff_id())));
drop policy if exists marketplace_message_outbox_admin_update on app.marketplace_message_outbox;
create policy marketplace_message_outbox_admin_update on app.marketplace_message_outbox for update to authenticated
using (app.is_admin()) with check (app.is_admin());

create or replace function app.read_marketplace_messages(p_item_id uuid)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare v_item app.items%rowtype;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  select * into v_item from app.items where id=p_item_id;
  if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then
    raise exception 'この商品の取引メッセージを閲覧する権限がありません' using errcode='42501';
  end if;
  return jsonb_build_object(
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'author',m.author,'author_role',m.author_role,'body',m.body,'sent_at',m.sent_at) order by m.sent_at nulls first,m.id)
      from app.marketplace_messages m where m.item_id=p_item_id),'[]'::jsonb),
    'outbox', coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'body',o.body,'status',o.status,'requested_at',o.requested_at,'sent_at',o.sent_at,'result_note',o.result_note) order by o.requested_at desc)
      from app.marketplace_message_outbox o where o.item_id=p_item_id and o.requested_by=auth.uid()),'[]'::jsonb)
  );
end; $$;

create or replace function app.queue_marketplace_message(p_item_id uuid,p_body text)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare v_item app.items%rowtype; v_market text; v_outbox_id uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  if length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'メッセージは1〜2000文字で入力してください'; end if;
  select * into v_item from app.items where id=p_item_id;
  if not found or not (app.is_admin() or app.current_role()='purchaser' or v_item.deliverer_id=app.current_staff_id()) then
    raise exception 'この商品の取引メッセージを送信する権限がありません' using errcode='42501';
  end if;
  if nullif(btrim(v_item.marketplace_item_id),'') is null then raise exception '取引IDが登録されていません'; end if;
  v_market:=v_item.marketplace::text;
  if v_market not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception 'この仕入先は取引メッセージ連携の対象外です'; end if;
  if exists(select 1 from app.marketplace_message_outbox where item_id=v_item.id and status in ('queued','sending')) then
    raise exception 'この商品の前の送信依頼が処理中です。結果を確認してから送信してください';
  end if;
  insert into app.marketplace_message_outbox(item_id,marketplace,marketplace_item_id,body,requested_by)
    values(v_item.id,v_market,v_item.marketplace_item_id,btrim(p_body),auth.uid()) returning id into strict v_outbox_id;
  return v_outbox_id;
end; $$;

create or replace function app.extension_marketplace_message_queue(p_marketplaces text[])
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'item_id',item_id,'marketplace',marketplace,'marketplace_item_id',marketplace_item_id,'body',body) order by requested_at)
    from app.marketplace_message_outbox where status='queued' and requested_at > now()-interval '7 days' and marketplace=any(p_marketplaces)),'[]'::jsonb);
end; $$;

create or replace function app.extension_claim_marketplace_message(p_id uuid,p_claimant text)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare changed integer;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  update app.marketplace_message_outbox set status='sending',claimed_at=now(),claimed_by=left(coalesce(p_claimant,''),120),result_note=null
   where id=p_id and (status='queued' or (status='sending' and claimed_at < now()-interval '10 minutes'));
  get diagnostics changed=row_count;
  return changed=1;
end; $$;

create or replace function app.extension_finish_marketplace_message(p_id uuid,p_status text,p_note text default null)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare changed integer;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  if p_status not in ('sent','failed','uncertain') then raise exception '送信結果が不正です'; end if;
  update app.marketplace_message_outbox set status=p_status,sent_at=case when p_status='sent' then now() else null end,result_note=left(p_note,500)
   where id=p_id and status='sending';
  get diagnostics changed=row_count;
  return changed=1;
end; $$;

create or replace function app.extension_sync_marketplace_messages(p_marketplace text,p_item_id text,p_account_label text,p_messages jsonb)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare linked_id uuid; affected integer; matched integer;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or length(p_item_id)>160 then raise exception '取引を特定できません'; end if;
  select count(*) into matched from app.items where marketplace_item_id=p_item_id and
   (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ'));
  if matched>1 then raise exception '同じ取引IDの商品が複数あり、メッセージを結び付けられません'; end if;
  if matched=1 then select id into linked_id from app.items where marketplace_item_id=p_item_id and
   (marketplace::text=p_marketplace or (p_marketplace='ヤフフリ' and marketplace::text='PayPayフリマ')); end if;
  if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>500 then raise exception '取引メッセージの形式が不正です'; end if;
  insert into app.marketplace_messages(marketplace,marketplace_item_id,item_id,external_id,author,author_role,body,sent_at)
  select p_marketplace,p_item_id,linked_id,entry->>'external_id',nullif(left(entry->>'author',200),''),
    case when entry->>'author_role' in ('self','other') then entry->>'author_role' else 'unknown' end,
    left(entry->>'body',10000),nullif(entry->>'sent_at','')::timestamptz
  from jsonb_array_elements(p_messages) entry
  where coalesce(entry->>'external_id','')<>'' and coalesce(entry->>'body','')<>''
  on conflict(marketplace,marketplace_item_id,external_id) do update set item_id=excluded.item_id,author=excluded.author,author_role=excluded.author_role,body=excluded.body,sent_at=coalesce(excluded.sent_at,app.marketplace_messages.sent_at),synced_at=now();
  get diagnostics affected=row_count;
  return affected;
end; $$;

grant execute on function app.read_marketplace_messages(uuid) to authenticated;
grant execute on function app.queue_marketplace_message(uuid,text) to authenticated;
grant execute on function app.extension_marketplace_message_queue(text[]) to authenticated;
grant execute on function app.extension_claim_marketplace_message(uuid,text) to authenticated;
grant execute on function app.extension_finish_marketplace_message(uuid,text,text) to authenticated;
grant execute on function app.extension_sync_marketplace_messages(text,text,text,jsonb) to authenticated;
