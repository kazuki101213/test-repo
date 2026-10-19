-- Packing evidence is an admin read receipt, never a listing/shipping approval.
create table app.packing_photo_notices(
 item_id uuid primary key references app.items(id) on delete cascade,
 source_photo_id uuid references app.item_photos(id) on delete set null,
 photo_count integer not null check(photo_count>0),
 submitted_at timestamptz not null default clock_timestamp(),
 checked_at timestamptz,checked_by uuid references app.staff(id)
);
alter table app.packing_photo_notices enable row level security;
revoke all on app.packing_photo_notices from public,anon,authenticated;
grant select on app.packing_photo_notices to authenticated;
grant all on app.packing_photo_notices to service_role;
create policy packing_photo_notices_read on app.packing_photo_notices for select to authenticated
 using(app.is_admin() and exists(select 1 from app.staff where id=app.current_staff_id() and is_active));
create function app.record_packing_photo_notice(p_item_id uuid,p_source_photo_id uuid,p_photo_count integer)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare latest uuid;n integer;saved integer;begin
 perform 1 from app.items where id=p_item_id for update;
 select count(*),count(drive_file_id) into n,saved from app.item_photos where item_id=p_item_id and photo_kind='packing';
 select id into latest from app.item_photos where item_id=p_item_id and photo_kind='packing' order by created_at desc,id desc limit 1;
 if n=0 or n<>p_photo_count or saved<>n or latest is distinct from p_source_photo_id then
  raise exception '梱包写真が更新されています。Googleドライブ追加を再実行してください' using errcode='40001';end if;
 insert into app.packing_photo_notices(item_id,source_photo_id,photo_count) values(p_item_id,latest,n)
 on conflict(item_id) do update set source_photo_id=excluded.source_photo_id,photo_count=excluded.photo_count,
  submitted_at=clock_timestamp(),checked_at=null,checked_by=null
 where app.packing_photo_notices.source_photo_id is distinct from excluded.source_photo_id or app.packing_photo_notices.photo_count<>excluded.photo_count;
end $$;
revoke all on function app.record_packing_photo_notice(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function app.record_packing_photo_notice(uuid,uuid,integer) to service_role;
create function app.acknowledge_packing_photos(p_item_id uuid,p_submitted_at timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ確認できます' using errcode='42501';end if;
 update app.packing_photo_notices set checked_at=coalesce(checked_at,clock_timestamp()),checked_by=coalesce(checked_by,app.current_staff_id())
 where item_id=p_item_id and submitted_at=p_submitted_at;
 if not found then raise exception '新しい梱包写真があります。確認画面を開き直してください' using errcode='40001';end if;
end $$;
revoke all on function app.acknowledge_packing_photos(uuid,timestamptz) from public,anon;
grant execute on function app.acknowledge_packing_photos(uuid,timestamptz) to authenticated;
alter table app.admin_push_events drop constraint admin_push_events_kind_check;
alter table app.admin_push_events add constraint admin_push_events_kind_check
 check(kind in ('malfunction','action','photo_review','invoice','receipts','packing_photo'));
create function app.capture_packing_photo_notice() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 perform app.enqueue_admin_push('packing_photo',new.item_id,new.item_id,null,null,null,new.submitted_at);
 return new;
end $$;
revoke all on function app.capture_packing_photo_notice() from public,anon,authenticated;
create trigger packing_photo_notice_push after insert or update of submitted_at on app.packing_photo_notices
 for each row execute function app.capture_packing_photo_notice();
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'case p_resource',
  'if p_resource=''packing_photos'' and not app.is_admin() then raise exception ''管理者のみ確認できます'' using errcode=''42501'';end if;' || chr(10) ||
  'case p_resource' || chr(10) ||
  'when ''packing_photos'' then source:=$q$select jsonb_build_object(''id'',n.item_id,''item_id'',n.item_id,''submitted_at'',n.submitted_at,''photo_count'',n.photo_count,''sku'',i.sku,''lot_seq'',i.lot_seq,''marketplace'',i.marketplace,''marketplace_item_id'',i.marketplace_item_id,''marketplace_url'',i.marketplace_url) d from app.packing_photo_notices n join app.items i on i.id=n.item_id where n.checked_at is null and exists(select 1 from app.item_photos p where p.item_id=i.id and p.photo_kind=''packing'')$q$;');
 if patched=original then raise exception 'Packing resource anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,'and case e.kind','and case e.kind' || chr(10) ||
  'when ''packing_photo'' then exists(select 1 from app.packing_photo_notices n where n.item_id=e.item_id and n.submitted_at=e.event_at and n.checked_at is null and exists(select 1 from app.item_photos p where p.item_id=n.item_id and p.photo_kind=''packing''))');
 if patched=original then raise exception 'Packing notification anchor missing';end if;execute patched;
end $patch$;
notify pgrst,'reload schema';
