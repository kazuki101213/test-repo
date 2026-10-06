create table if not exists app.item_comment_template_photos (
  id uuid primary key default gen_random_uuid(),
  task_kind text not null check (task_kind = 'Panasonic◯ヤフオク'),
  file_name text not null,
  mime_type text not null check (mime_type = 'image/jpeg'),
  photo_base64 text not null,
  sort_order smallint not null check (sort_order between 1 and 9),
  created_at timestamptz not null default now(),
  unique(task_kind, sort_order),
  check (length(photo_base64) > 0)
);

alter table app.item_comment_template_photos enable row level security;
grant select on app.item_comment_template_photos to authenticated;
grant all on app.item_comment_template_photos to service_role;

drop policy if exists item_comment_template_photos_admin_select on app.item_comment_template_photos;
create policy item_comment_template_photos_admin_select
  on app.item_comment_template_photos for select to authenticated
  using (app.current_role() = 'admin');
