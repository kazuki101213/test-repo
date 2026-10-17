-- Reuse the extension's completion ledger without changing its write protocol.
create table if not exists app.marketplace_extension_receipts (
 marketplace text not null,marketplace_item_id text not null,token uuid not null unique default gen_random_uuid(),
 account_label text not null,state text not null check(state in ('reserved','submitting','succeeded','unknown')),
 reserved_by uuid not null,reserved_at timestamptz not null default now(),updated_at timestamptz not null default now(),details text,
 primary key(marketplace,marketplace_item_id)
);
alter table app.marketplace_extension_receipts enable row level security;
grant select on app.marketplace_extension_receipts to authenticated;
create policy receipt_task_completion_read on app.marketplace_extension_receipts for select to authenticated using(app.is_admin());

create table app.receipt_evaluation_tasks (
 item_id uuid primary key references app.items(id) on delete cascade,
 requested_at timestamptz not null,completed_at timestamptz,completed_by uuid references app.staff(id)
);
alter table app.receipt_evaluation_tasks enable row level security;
revoke all on app.receipt_evaluation_tasks from public,anon,authenticated;
grant select on app.receipt_evaluation_tasks to authenticated;
grant all on app.receipt_evaluation_tasks to service_role;
create policy receipt_tasks_admin_read on app.receipt_evaluation_tasks for select to authenticated using(app.is_admin());

create function app.enqueue_inspection_receipt_task() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.action='inspection_complete' then
  insert into app.receipt_evaluation_tasks(item_id,requested_at)
  select id,new.created_at from app.items where id=new.item_id and marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
  on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null;
 end if;
 return new;
end $$;
revoke all on function app.enqueue_inspection_receipt_task() from public,anon,authenticated;
create trigger inspection_receipt_task after insert on app.inventory_workflow_events for each row execute function app.enqueue_inspection_receipt_task();

-- Only explicit inspection-complete actions create tasks; old imported timestamps do not.
insert into app.receipt_evaluation_tasks(item_id,requested_at)
select e.item_id,max(e.created_at) from app.inventory_workflow_events e join app.items i on i.id=e.item_id
where e.action='inspection_complete' and i.inspected_at is not null and i.cleaned_at is not null
and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') group by e.item_id;

create view app.v_receipt_evaluation_tasks with(security_invoker=true) as
select t.item_id as id,t.item_id,t.requested_at,i.sku,i.lot_seq,i.title,p.model_no,i.asin,i.marketplace,i.marketplace_item_id,i.marketplace_url
from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id left join app.products p on p.id=i.product_id
where t.completed_at is null and i.inspected_at is not null and i.cleaned_at is not null
and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
and not exists(select 1 from app.marketplace_extension_receipts r
 where r.marketplace=case when i.marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else i.marketplace::text end
 and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded');
grant select on app.v_receipt_evaluation_tasks to authenticated;

create function app.complete_receipt_evaluation_task(p_item_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 update app.receipt_evaluation_tasks set completed_at=coalesce(completed_at,clock_timestamp()),completed_by=coalesce(completed_by,app.current_staff_id()) where item_id=p_item_id;
 if not found then raise exception '受取評価のやることがありません' using errcode='22023';end if;
end $$;
revoke all on function app.complete_receipt_evaluation_task(uuid) from public,anon;
grant execute on function app.complete_receipt_evaluation_task(uuid) to authenticated;

do $$declare definition text;patched text;begin
 definition:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 patched:=replace(definition,'''invoice_tasks'',''photo_reviews'',''listing_tasks'',''actions''','''invoice_tasks'',''photo_reviews'',''listing_tasks'',''actions'',''receipt_tasks''');
 patched:=replace(patched,'when ''invoice_tasks'' then source:=','when ''receipt_tasks'' then source:=$receipt$select to_jsonb(t) d from app.v_receipt_evaluation_tasks t$receipt$;
 when ''invoice_tasks'' then source:=');
 if patched=definition or position('v_receipt_evaluation_tasks' in patched)=0 then raise exception 'Receipt resource anchor missing';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';
