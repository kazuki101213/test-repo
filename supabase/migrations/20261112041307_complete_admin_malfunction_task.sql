create table app.malfunction_task_completions (
  item_id uuid primary key references app.items(id) on delete cascade,
  reported_at timestamptz not null
);
alter table app.malfunction_task_completions enable row level security;
revoke all on app.malfunction_task_completions from public,anon,authenticated;

create function app.complete_malfunction_task(p_item_id uuid, p_reported_at timestamptz) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare
  actor_id uuid := app.current_staff_id();
  item app.items;
begin
  if auth.uid() is null or actor_id is null
     or not exists (select 1 from app.staff where id=actor_id and is_active) then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;

  select * into item from app.items where id=p_item_id for no key update;
  if not found or not coalesce(app.is_admin() or (app.current_role()='purchaser' and item.purchaser_id=actor_id),false) then
    raise exception 'このやることを完了する権限がありません' using errcode='42501';
  end if;
  if p_reported_at is null or p_reported_at is distinct from item.malfunction_reported_at
     or item.status<>'動作不良' or not item.malfunction_reported
     or item.malfunction_resolved_at is not null or item.sold_on is not null then
    raise exception '動作不良の報告が更新されています。一覧を再読み込みしてください' using errcode='40001';
  end if;

  insert into app.malfunction_task_completions as completion(item_id,reported_at)
  values (p_item_id,p_reported_at)
  on conflict (item_id) do update set reported_at=excluded.reported_at
  where completion.reported_at is distinct from excluded.reported_at;
end;
$$;
revoke all on function app.complete_malfunction_task(uuid,timestamptz) from public,anon,authenticated;
grant execute on function app.complete_malfunction_task(uuid,timestamptz) to authenticated;

-- Reopen the management task when the assigned delivery worker sends a new message.
create or replace function app.capture_admin_malfunction_message() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
  if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then
    return new;
  end if;

  insert into app.admin_push_events(staff_id,kind,source_id,item_id,event_at,source_key)
  select recipient.id,'malfunction_message',new.id,i.id,new.created_at,'malfunction_message:'||new.id
  from app.items i
  join app.staff author on author.id=new.author_id and author.is_active
  join app.staff recipient on recipient.is_active and recipient.id<>author.id
    and (recipient.role='admin' or (recipient.role='purchaser' and recipient.id=i.purchaser_id))
  where i.id=new.item_id and i.deliverer_id=author.id
    and (author.role='deliverer' or (author.role='purchaser' and author.id is distinct from i.purchaser_id))
    and i.malfunction_reported and i.malfunction_resolved_at is null
    and (i.status='動作不良' or (i.status='Amazon補填申請中'
      and i.compensation_report_completed_for is distinct from i.malfunction_reported_at))
    and i.sold_on is null and new.created_at>i.malfunction_reported_at
  on conflict (staff_id,source_key) do nothing;

  if found then
    perform 1 from app.items where id=new.item_id and status='動作不良' for no key update;
    if found then
      delete from app.malfunction_task_completions where item_id=new.item_id;
    end if;
  end if;
  return new;
end;
$$;

do $patch$
declare original text; patched text;
begin
  original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  patched:=replace(original,
    'where (i.status<>''Amazon補填申請中'' or i.compensation_report_completed_for is distinct from i.malfunction_reported_at) and i.malfunction_reported',
    'where (i.status<>''Amazon補填申請中'' or i.compensation_report_completed_for is distinct from i.malfunction_reported_at)
      and (i.status<>''動作不良'' or not exists(select 1 from app.malfunction_task_completions done where done.item_id=i.id and done.reported_at=i.malfunction_reported_at)) and i.malfunction_reported');
  if original=patched then raise exception 'Management malfunction snapshot source changed'; end if;
  execute patched;

  original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
  patched:=replace(original,'and case e.kind',
    'and (e.kind not in (''malfunction'',''malfunction_message'') or i.status<>''動作不良''
      or not exists(select 1 from app.malfunction_task_completions done where done.item_id=i.id and done.reported_at=i.malfunction_reported_at))
      and case e.kind');
  if original=patched then raise exception 'Management push source changed'; end if;
  execute patched;
end;
$patch$;
notify pgrst,'reload schema';
