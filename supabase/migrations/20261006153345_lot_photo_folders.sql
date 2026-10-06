-- One canonical Google Drive folder per lot, independent of SKU/return rows.
create table app.lot_photo_folders (
  lot_seq bigint primary key,
  drive_folder_id text not null
);
alter table app.lot_photo_folders enable row level security;
revoke all on app.lot_photo_folders from anon, authenticated;
grant all on app.lot_photo_folders to service_role;

-- Reuse the oldest known folder. Files are consolidated on the next save;
-- old folders and photos are not deleted by this migration.
insert into app.lot_photo_folders (lot_seq, drive_folder_id)
select distinct on (i.lot_seq) i.lot_seq, r.drive_folder_id
from app.items i join app.photo_reviews r on r.item_id = i.id
where r.drive_folder_id is not null
order by i.lot_seq, r.submitted_at, i.id;
