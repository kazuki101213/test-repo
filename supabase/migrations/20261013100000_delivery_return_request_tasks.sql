-- Amazon返品が作業中になった商品に、返送依頼作成タスクを作る。
create table if not exists app.delivery_return_request_tasks (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references app.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references app.staff(id) on delete set null
);

create index if not exists delivery_return_request_open_idx
  on app.delivery_return_request_tasks(created_at desc)
  where completed_at is null;

alter table app.delivery_return_request_tasks enable row level security;
revoke all on app.delivery_return_request_tasks from public, anon, authenticated;
grant select on app.delivery_return_request_tasks to authenticated;

drop policy if exists delivery_return_request_select on app.delivery_return_request_tasks;
create policy delivery_return_request_select on app.delivery_return_request_tasks
  for select to authenticated using (
    exists (
      select 1 from app.items i
      where i.id = item_id
        and (app.is_admin() or app.current_role() = 'purchaser' or i.deliverer_id = app.current_staff_id())
    )
  );

create or replace function app.create_delivery_return_request_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.marketplace = 'Amazon返品'::app.marketplace
     and new.status = '作業中'::app.item_status
     and (tg_op = 'INSERT' or old.marketplace is distinct from new.marketplace or old.status is distinct from new.status)
     and not exists (
       select 1 from app.delivery_return_request_tasks t
       where t.item_id = new.id and t.completed_at is null
     ) then
    insert into app.delivery_return_request_tasks(item_id) values (new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists items_create_delivery_return_request_task on app.items;
create trigger items_create_delivery_return_request_task
  after insert or update of marketplace, status on app.items
  for each row execute function app.create_delivery_return_request_task();

insert into app.delivery_return_request_tasks(item_id)
select i.id
from app.items i
where i.marketplace = 'Amazon返品'::app.marketplace
  and i.status = '作業中'::app.item_status
  and not exists (
    select 1 from app.delivery_return_request_tasks t
    where t.item_id = i.id and t.completed_at is null
  );

create or replace view app.v_delivery_return_request_tasks with (security_invoker = true) as
select t.id, t.item_id, i.sku, i.lot_seq, i.title, p.model_no, i.asin,
       i.deliverer_id, t.created_at, t.completed_at
from app.delivery_return_request_tasks t
join app.items i on i.id = t.item_id
left join app.products p on p.id = i.product_id
where t.completed_at is null
  and i.marketplace = 'Amazon返品'::app.marketplace
  and i.status = '作業中'::app.item_status;

revoke all on app.v_delivery_return_request_tasks from public, anon;
grant select on app.v_delivery_return_request_tasks to authenticated;

create or replace function app.complete_delivery_return_request_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item app.items;
begin
  if auth.uid() is null then raise exception '認証が必要です' using errcode = '42501'; end if;
  select i.* into v_item
  from app.delivery_return_request_tasks t join app.items i on i.id = t.item_id
  where t.id = p_task_id and t.completed_at is null for update;
  if not found then raise exception '対象の返送依頼作成タスクが見つかりません' using errcode = 'P0002'; end if;
  if not (app.is_admin() or app.current_role() = 'purchaser' or v_item.deliverer_id = app.current_staff_id()) then
    raise exception 'タスク完了の権限がありません' using errcode = '42501';
  end if;
  update app.delivery_return_request_tasks
    set completed_at = clock_timestamp(), completed_by = app.current_staff_id()
    where id = p_task_id and completed_at is null;
end;
$$;
revoke all on function app.complete_delivery_return_request_task(uuid) from public, anon;
grant execute on function app.complete_delivery_return_request_task(uuid) to authenticated;
notify pgrst, 'reload schema';
