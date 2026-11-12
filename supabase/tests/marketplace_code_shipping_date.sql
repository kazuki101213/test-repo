begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';

insert into app.delivery_line_links(staff_id,line_user_id)
select id,'U'||repeat('e',32) from app.staff where code='DD';
update app.delivery_line_settings set enabled=true;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date,'dispatch date fixture',100,'ヤフオク',
 (case when n=998661 then 'メルカリ' else 'ヤフオク' end)::app.sales_channel,'出品中'
from generate_series(998661,998664) n;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
select id,sales_channel,case when lot_seq=998661 then 'mercari-2' else 'auctions-2' end,
 'm'||lot_seq,case when lot_seq=998661 then 'https://jp.mercari.com/item/m'
 else 'https://page.auctions.yahoo.co.jp/jp/auction/m' end||lot_seq,'trade-'||lot_seq
from app.items where lot_seq between 998661 and 998664;
update app.items set status='取引中',seller_trade_key='trade-'||lot_seq
where lot_seq between 998661 and 998664;
update app.items set shipped_on='2026-11-02' where lot_seq=998664;

insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload)
select gen_random_uuid(),i.id,i.deliverer_id,case when i.lot_seq=998662 then 'register_package' else 'shipping_code' end,
 l.channel,l.account_id,'取引中',i.updated_at,
 jsonb_build_object('trade_key',case when i.lot_seq=998663 then 'old-trade' else l.trade_key end)
from app.items i join app.seller_listings l on l.item_id=i.id
where i.lot_seq between 998661 and 998664;
update app.seller_operations o set status='failed',finished_at='2026-11-03 14:55:00+00'
from app.items i where i.id=o.item_id and i.lot_seq=998661;

do $$begin
 if (select shipped_on from app.items where lot_seq=998661) is not null then
   raise exception 'Failed code set a dispatch date';
 end if;
end$$;

update app.seller_operations o set status='succeeded',finished_at='2026-11-03 15:05:00+00'
from app.items i where i.id=o.item_id and i.lot_seq between 998661 and 998664;

do $$
declare item record; queued uuid;
begin
 for item in select id,lot_seq,shipped_on from app.items where lot_seq in (998661,998662) loop
   if item.shipped_on is distinct from date '2026-11-04' then
     raise exception 'Expected Japan dispatch date for %',item.lot_seq;
   end if;
   if exists(select 1 from app.delivery_shipping_tasks where item_id=item.id and resolved_at is null) then
     raise exception 'Dispatch task still open for %',item.lot_seq;
   end if;
   select o.id into queued from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id
   where t.item_id=item.id and o.code_issue_operation_id is not null;
   if queued is null or not app.line_shipping_eligible(queued) then
     raise exception 'Issued code blocked the queued LINE request for %',item.lot_seq;
   end if;
   update app.seller_listings set active=false where item_id=item.id;
   if app.line_shipping_eligible(queued) then raise exception 'Inactive trade can still send LINE'; end if;
 end loop;
 if (select shipped_on from app.items where lot_seq=998663) is not null then
   raise exception 'Old trade set a dispatch date';
 end if;
 if (select shipped_on from app.items where lot_seq=998664) is distinct from date '2026-11-02' then
   raise exception 'Existing dispatch date was overwritten';
 end if;
end$$;
rollback;
