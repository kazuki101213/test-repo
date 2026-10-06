alter table app.item_comments
  add column if not exists task_kind text,
  add column if not exists task_completed_at timestamptz,
  add column if not exists task_completed_by uuid references app.staff(id) on delete set null;

alter table app.item_comments drop constraint if exists item_comments_task_kind_check;
alter table app.item_comments add constraint item_comments_task_kind_check check (
  task_kind is null or task_kind in (
    'Amazon販売', '仕入先確認',
    'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
    'SONY◯ヤフオク', 'SONY×ヤフオク',
    'SHARP◯ヤフオク', 'SHARP×ヤフオク',
    'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク'
  )
);

create index if not exists item_comments_open_tasks_idx
  on app.item_comments(created_at desc) where task_kind is not null and task_completed_at is null;

create table if not exists app.item_comment_photos (
  id uuid primary key default gen_random_uuid(),
  item_comment_id uuid not null references app.item_comments(id) on delete cascade,
  item_id uuid not null references app.items(id) on delete cascade,
  storage_path text not null unique,
  sort_order smallint not null default 0 check (sort_order between 0 and 9),
  created_at timestamptz not null default now(),
  unique(item_comment_id, sort_order)
);

alter table app.item_comment_photos enable row level security;
grant select, insert on app.item_comment_photos to authenticated;
grant all on app.item_comment_photos to service_role;

drop policy if exists item_comment_photos_select on app.item_comment_photos;
create policy item_comment_photos_select on app.item_comment_photos
  for select to authenticated using (
    exists (
      select 1 from app.items i
      where i.id = item_id
        and (app.current_role() in ('admin','purchaser') or i.deliverer_id = app.current_staff_id())
    )
  );

drop policy if exists item_comment_photos_insert on app.item_comment_photos;
create policy item_comment_photos_insert on app.item_comment_photos
  for insert to authenticated with check (
    exists (
      select 1 from app.item_comments c join app.items i on i.id = c.item_id
      where c.id = item_comment_id and c.item_id = item_comment_photos.item_id
        and c.author_id = app.current_staff_id()
        and (app.current_role() in ('admin','purchaser') or i.deliverer_id = app.current_staff_id())
    )
  );

create or replace function app.complete_item_comment_task(p_comment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception 'タスク完了の権限がありません' using errcode = '42501';
  end if;
  update app.item_comments
    set task_completed_at = clock_timestamp(), task_completed_by = app.current_staff_id()
    where id = p_comment_id and task_kind is not null and task_completed_at is null;
  if not found and not exists (
    select 1 from app.item_comments where id = p_comment_id and task_kind is not null
  ) then
    raise exception '対象のタスクが見つかりません' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function app.complete_item_comment_task(uuid) from public, anon, authenticated;
grant execute on function app.complete_item_comment_task(uuid) to authenticated;
