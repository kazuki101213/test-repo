alter table app.item_comment_template_photos
  drop constraint if exists item_comment_template_photos_task_kind_check;
alter table app.item_comment_template_photos
  add constraint item_comment_template_photos_task_kind_check
  check (task_kind in ('Panasonic◯ヤフオク', 'Panasonic×ヤフオク'));
