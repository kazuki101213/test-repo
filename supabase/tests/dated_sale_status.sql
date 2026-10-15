-- Isolate the production trigger function without mutating inventory fixtures.
begin;
create temporary table dated_sale_probe as select * from app.items with no data;
alter table dated_sale_probe add column probe_id integer;
create trigger preserve_dated_sale before insert or update on dated_sale_probe
for each row execute function app.items_sync_status();
insert into dated_sale_probe(probe_id,marketplace,cost_amount,status,sold_on,shipped_on) values
 (1,'ヤフオク',100,'出品中',date '2026-10-07',date '2026-10-07'),
 (2,'メルカリ',100,'出品中',date '2026-10-07',null),
 (3,'ヤフオク',100,'返品処理',date '2026-10-07',null),
 (4,'ヤフオク',100,'受取前',null,null),
 (5,'動作品Amazon返品',100,'出品中',date '2026-10-07',null);
-- Simulate the stale listing task, including its shipment timestamp variant.
update dated_sale_probe set status='出品中' where probe_id in (1,2,5);
update dated_sale_probe set shipped_on=date '2026-10-08' where probe_id in (1,2);
-- Existing explicit listing of an unsold item must still work.
update dated_sale_probe set status='出品中' where probe_id=4;
do $$
begin
 if exists(select 1 from dated_sale_probe where probe_id in (1,2,5) and status<>'販売済') then
   raise exception 'A dated sale was reopened by listing/shipping';
 end if;
 if (select status from dated_sale_probe where probe_id=3)<>'返品処理' then
   raise exception 'Supplier return was changed';
 end if;
 if (select status from dated_sale_probe where probe_id=4)<>'出品中' then
   raise exception 'Unsold listing behavior changed';
 end if;
 if (select cost_amount from dated_sale_probe where probe_id=5)<>0 then
   raise exception 'Amazon return cost zeroing regressed';
 end if;
end $$;
rollback;
