-- A sold item must retain its sale date, but its sale amount may be unknown.
-- This allows classifying a sold accessory row as a main item without inventing a price.
alter table app.items drop constraint if exists items_sold_requires_date;
alter table app.items add constraint items_sold_requires_date check (
  status <> '販売済' or sold_on is not null
);