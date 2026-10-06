alter table app.item_comment_template_photos
  drop constraint if exists item_comment_template_photos_sort_order_check;

alter table app.item_comment_template_photos
  add constraint item_comment_template_photos_sort_order_check
  check (sort_order between 1 and 10);
