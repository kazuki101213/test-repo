-- Explicit return tasks survive reads and disappear only when work is resubmitted.
alter table app.photo_reviews add column rejected_at timestamptz;
alter table app.photo_reviews add column rejected_by uuid references app.staff(id);
alter table app.photo_reviews add column rejection_reason text;
create table app.delivery_return_tasks (
 id uuid primary key, item_id uuid not null references app.items(id) on delete cascade,
 kind text not null check(kind in ('photo_return','malfunction_return')),
 reason text not null check(length(btrim(reason)) between 1 and 2000 and reason ~ '[^[:space:]　]'),
 source_at timestamptz not null, actor_id uuid not null references app.staff(id),
 created_at timestamptz not null default clock_timestamp(), resolved_at timestamptz
);
create unique index delivery_return_tasks_active on app.delivery_return_tasks(item_id,kind) where resolved_at is null;
create index delivery_return_tasks_item on app.delivery_return_tasks(item_id,created_at);
alter table app.delivery_return_tasks enable row level security;
revoke all on app.delivery_return_tasks from public,anon,authenticated;
grant select on app.delivery_return_tasks to authenticated;
grant all on app.delivery_return_tasks to service_role;
create policy delivery_return_tasks_read on app.delivery_return_tasks for select to authenticated using(
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id()))
);
create view app.v_delivery_return_tasks with(security_invoker=true) as
 select t.id,t.item_id,t.kind,t.reason,t.created_at,i.sku,i.lot_seq,i.marketplace_item_id
 from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null;
revoke all on app.v_delivery_return_tasks from public,anon;
grant select on app.v_delivery_return_tasks to authenticated,service_role;

alter table app.delivery_push_events drop constraint delivery_push_events_kind_check;
alter table app.delivery_push_events add constraint delivery_push_events_kind_check
 check(kind in ('reply','photo','assigned','photo_return','malfunction_return'));
create function app.notify_delivery_return() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 perform app.enqueue_delivery_push(new.item_id,new.kind,new.created_at,new.actor_id);
 return new;
end $$;
revoke all on function app.notify_delivery_return() from public,anon,authenticated;
create trigger delivery_return_task_push after insert on app.delivery_return_tasks for each row execute function app.notify_delivery_return();

create function app.reject_photo_review(p_item_id uuid,p_submitted_at timestamptz,p_reason text,p_request_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare r app.photo_reviews; t app.delivery_return_tasks; actor uuid:=app.current_staff_id(); returned_at timestamptz:=clock_timestamp();
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=actor and is_active) then
  raise exception '写真確認の権限がありません' using errcode='42501';end if;
 if p_request_id is null or p_reason is null or p_reason !~ '[^[:space:]　]' or length(btrim(p_reason)) not between 1 and 2000 then
  raise exception '差し戻し理由を1〜2000文字で入力してください' using errcode='22023';end if;
 -- Serialize against work/status changes, then against approval and submission.
 perform 1 from app.items where id=p_item_id for update;
 select * into t from app.delivery_return_tasks where id=p_request_id;
 if found then
  if t.item_id=p_item_id and t.kind='photo_return' and t.actor_id=actor and t.source_at=p_submitted_at and t.reason=btrim(p_reason) then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';end if;
 select * into r from app.photo_reviews where item_id=p_item_id for update;
 if r.item_id is null or r.submitted_at is distinct from p_submitted_at or r.approved_at is not null or r.rejected_at is not null then
  raise exception '写真の提出状態が更新されています。確認画面を開き直してください' using errcode='40001';end if;
 update app.photo_reviews set rejected_at=returned_at,rejected_by=actor,rejection_reason=btrim(p_reason),
  approved_at=null,approved_by=null,updated_at=returned_at where item_id=p_item_id;
 insert into app.delivery_return_tasks(id,item_id,kind,reason,source_at,actor_id,created_at)
 values(p_request_id,p_item_id,'photo_return',btrim(p_reason),r.submitted_at,actor,returned_at);
end $$;
revoke all on function app.reject_photo_review(uuid,timestamptz,text,uuid) from public,anon;
grant execute on function app.reject_photo_review(uuid,timestamptz,text,uuid) to authenticated;

create function app.resubmit_returned_photos() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if tg_op='INSERT' or new.submitted_at is distinct from old.submitted_at then
  new.rejected_at:=null;new.rejected_by:=null;new.rejection_reason:=null;
  update app.delivery_return_tasks set resolved_at=clock_timestamp()
   where item_id=new.item_id and kind='photo_return' and resolved_at is null and source_at<new.submitted_at;
 end if;
 return new;
end $$;
revoke all on function app.resubmit_returned_photos() from public,anon,authenticated;
create trigger photo_reviews_resubmit_return before insert or update of submitted_at on app.photo_reviews
 for each row execute function app.resubmit_returned_photos();

create function app.track_returned_reports() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if new.action='send_back' then
  insert into app.delivery_return_tasks(id,item_id,kind,reason,source_at,actor_id,created_at)
   values(new.id,new.item_id,'malfunction_return',btrim(new.note),new.created_at,new.actor_id,new.created_at);
 elsif new.action in ('report','inspection_complete') then
  update app.delivery_return_tasks set resolved_at=new.created_at
   where item_id=new.item_id and kind='malfunction_return' and resolved_at is null and created_at<new.created_at;
 end if;
 return new;
end $$;
revoke all on function app.track_returned_reports() from public,anon,authenticated;
create trigger inventory_workflow_return_task after insert on app.inventory_workflow_events for each row execute function app.track_returned_reports();

-- Patch the current definitions rather than replacing other workflow/resource changes.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
 patched:=replace(original,'when ''report_cancel'',''send_back'' then',
  'when ''report_cancel'',''send_back'' then' || chr(10) ||
  '  if p_action=''send_back'' and nullif(btrim(p_note),'''') is null then raise exception ''差し戻し理由を入力してください'' using errcode=''22023'';end if;');
 if patched=original then raise exception 'Workflow return anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.approve_photo_review(uuid)'::regprocedure);
 patched:=replace(original,'approved_at is null and exported_photo_count','approved_at is null and rejected_at is null and exported_photo_count');
 if patched=original then raise exception 'Photo approval anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'where r.approved_at is null$q$','where r.approved_at is null and r.rejected_at is null$q$');
 patched:=replace(patched,'case p_resource','case p_resource' || chr(10) ||
  ' when ''return_tasks'' then source:=$q$select to_jsonb(t) d from app.v_delivery_return_tasks t$q$;');
 if patched=original or strpos(patched,'r.rejected_at is null')=0 then raise exception 'Resource return anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,'when ''photo_review'' then p.approved_at is null','when ''photo_review'' then p.rejected_at is null and p.approved_at is null');
 if patched=original then raise exception 'Admin photo eligibility anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_delivery_push()'::regprocedure);
 patched:=replace(original,'and case e.kind','and case e.kind' || chr(10) ||
  ' when ''photo_return'' then exists(select 1 from app.delivery_return_tasks t where t.item_id=i.id and t.kind=e.kind and t.created_at=e.event_at and t.resolved_at is null)' || chr(10) ||
  ' when ''malfunction_return'' then exists(select 1 from app.delivery_return_tasks t where t.item_id=i.id and t.kind=e.kind and t.created_at=e.event_at and t.resolved_at is null)');
 if patched=original then raise exception 'Delivery return eligibility anchor missing';end if;execute patched;
end $patch$;
notify pgrst,'reload schema';
