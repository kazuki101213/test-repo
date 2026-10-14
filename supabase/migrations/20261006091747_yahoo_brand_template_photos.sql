-- Define the table before extending its check on fresh installations.
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
alter table app.item_comment_template_photos
  drop constraint if exists item_comment_template_photos_task_kind_check;

alter table app.item_comment_template_photos
  add constraint item_comment_template_photos_task_kind_check
  check (task_kind in (
    'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
    'SONY◯ヤフオク', 'SONY×ヤフオク',
    'SHARP◯ヤフオク', 'SHARP×ヤフオク',
    'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク'
  ));
