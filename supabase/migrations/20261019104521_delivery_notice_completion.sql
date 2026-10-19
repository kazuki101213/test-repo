-- Completion is per viewer and exact event; it never approves photos or resolves work.
create table app.delivery_notice_completions (
 staff_id uuid not null references app.staff(id) on delete cascade,
 notice_id text not null check(length(notice_id) between 1 and 200),
 item_id uuid not null references app.items(id) on delete cascade,
 completed_at timestamptz not null default clock_timestamp(),
 primary key(staff_id,notice_id)
);
alter table app.delivery_notice_completions enable row level security;
revoke all on app.delivery_notice_completions from public,anon,authenticated;
grant select on app.delivery_notice_completions to authenticated;
grant all on app.delivery_notice_completions to service_role;
create policy delivery_notice_completions_self on app.delivery_notice_completions for select to authenticated
 using(staff_id=app.current_staff_id() and exists(select 1 from app.staff where id=app.current_staff_id() and is_active));

-- Preserve acknowledgements that predate the explicit completion buttons.
insert into app.delivery_notice_completions(staff_id,notice_id,item_id)
 select n.staff_id,'approved:'||p.item_id::text||':'||extract(epoch from p.approved_at)::text,p.item_id
 from app.item_notice_reads n join app.photo_reviews p on p.item_id=n.item_id
 where p.approved_at is not null and n.photo_read_at>=p.approved_at
 union all
 select n.staff_id,case when t.id is not null then t.id::text else 'reply:'||c.id::text end,c.item_id
 from app.item_notice_reads n join app.item_comments c on c.item_id=n.item_id
 join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
 left join app.delivery_return_tasks t on t.id=c.id
 where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at and n.reply_read_at>=c.created_at
 on conflict do nothing;

create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Keep the view column for compatibility, with no expiration value or timer.
  null::timestamptz expires_at,n.reason
 from latest n
 where auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;

create function app.complete_delivery_notice(p_notice_id text,p_item_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare actor uuid:=app.current_staff_id(); notice record;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=actor and is_active)
 or not exists(select 1 from app.items where id=p_item_id and (app.is_admin() or deliverer_id=actor)) then
  raise exception 'この案内を完了する権限がありません' using errcode='42501';end if;
 if exists(select 1 from app.delivery_notice_completions where staff_id=actor and notice_id=p_notice_id and item_id=p_item_id) then return;end if;
 select * into notice from app.v_delivery_notice_tasks where id=p_notice_id and item_id=p_item_id;
 if not found then raise exception '案内が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 insert into app.delivery_notice_completions(staff_id,notice_id,item_id) values(actor,p_notice_id,p_item_id) on conflict do nothing;
 if notice.kind in ('photo_approved','reply') then
  insert into app.item_notice_reads(staff_id,item_id,reply_read_at,photo_read_at)
  values(actor,p_item_id,case when notice.kind='reply' then notice.created_at end,case when notice.kind='photo_approved' then notice.created_at end)
  on conflict(staff_id,item_id) do update set
   reply_read_at=greatest(app.item_notice_reads.reply_read_at,excluded.reply_read_at),
   photo_read_at=greatest(app.item_notice_reads.photo_read_at,excluded.photo_read_at);
 end if;
end $$;
revoke all on function app.complete_delivery_notice(text,uuid) from public,anon;
grant execute on function app.complete_delivery_notice(text,uuid) to authenticated;

-- Reuse the existing bounded snapshot, adding only the current sales channel.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(original,'''lot_seq'',i.lot_seq)) d from app.photo_reviews',
  '''lot_seq'',i.lot_seq,''sales_channel'',i.sales_channel)) d from app.photo_reviews');
 if patched=original then raise exception 'Photo review item anchor missing';end if;execute patched;
end $patch$;

-- Supplier confirmation stays in conversation history, without a separate admin task/push.
create or replace view app.v_item_action_tasks with(security_invoker=true) as
 select c.id,c.item_id,c.task_kind,c.task_completed_at,c.created_at,
  i.lot_seq,i.sku,app.resolve_task_product_id(i.id) marketplace_item_id
 from app.item_comments c join app.items i on i.id=c.item_id
 where c.task_kind is not null and c.task_kind<>'仕入先確認';
revoke all on app.v_item_action_tasks from public,anon;
grant select on app.v_item_action_tasks to authenticated;
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.capture_admin_push()'::regprocedure);
 patched:=replace(original,'should_send:=new.task_kind is not null and new.task_completed_at is null;',
  'should_send:=new.task_kind is not null and new.task_kind<>''仕入先確認'' and new.task_completed_at is null;');
 if patched=original then raise exception 'Supplier action push anchor missing';end if;execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,'when ''action'' then c.task_kind is not null and c.task_completed_at is null',
  'when ''action'' then c.task_kind is not null and c.task_kind<>''仕入先確認'' and c.task_completed_at is null');
 if patched=original then raise exception 'Pending supplier action push anchor missing';end if;execute patched;
end $patch$;
notify pgrst,'reload schema';
