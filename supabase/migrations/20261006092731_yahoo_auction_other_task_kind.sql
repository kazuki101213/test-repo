alter table app.item_comments
  drop constraint if exists item_comments_task_kind_check;

alter table app.item_comments
  add constraint item_comments_task_kind_check
  check (
    task_kind is null or task_kind in (
      'Amazon販売', '仕入先確認',
      'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
      'SONY◯ヤフオク', 'SONY×ヤフオク',
      'SHARP◯ヤフオク', 'SHARP×ヤフオク',
      'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク',
      'ヤフオク その他'
    )
  );
