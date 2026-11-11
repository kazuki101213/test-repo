begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';

insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select n, (select id from app.staff where code='AA'), (select id from app.staff where code='DD'),
  current_date-10, 'Management deadline fixture', 1000, 'メルカリ',
  (case when n in (997612,997613,997622,997623) then 'ヤフオク'
    when n=997614 then 'FBA2' when n in (997615,997624) then '自己発送2'
    else 'メルカリ' end)::app.sales_channel,
  case when n<997619 then 'fixture-tracking' end
from generate_series(997610,997624) n;

update app.items set inspected_at=now(),status='商品登録前' where lot_seq between 997610 and 997616;
update app.item_tracking_recordings t
set recorded_at=now()-case when i.lot_seq<=997616 then interval '7 days' else interval '3 days' end
  +case when i.lot_seq in (997616,997618) then interval '1 second' else interval '0 seconds' end
from app.items i where i.id=t.item_id and i.lot_seq between 997610 and 997618;

-- The formerly eligible photo approval is old, while the tracking clock is
-- one second short of the new deadline. Other listing fixtures have no approval.
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at,approved_at,approved_by)
select id,'deadline-fixture',1,now()-interval '10 days',now()-interval '9 days',purchaser_id
from app.items where lot_seq=997616;

update app.items set status='取引中',seller_trade_key='fixture-'||lot_seq where lot_seq between 997620 and 997624;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
select i.id,i.sales_channel,
  case i.lot_seq when 997620 then 'mercari-1' when 997621 then 'mercari-2' when 997622 then 'auctions-1' else 'auctions-2' end,
  (case when i.sales_channel='メルカリ' then 'm' else 'u' end)||i.lot_seq,
  (case when i.sales_channel='メルカリ' then 'https://jp.mercari.com/item/m' else 'https://auctions.yahoo.co.jp/jp/auction/u' end)||i.lot_seq,
  i.seller_trade_key
from app.items i where i.lot_seq between 997620 and 997623;
update app.delivery_shipping_tasks t
set created_at=now()-interval '24 hours'+case when i.lot_seq=997624 then interval '1 second' else interval '0 seconds' end
from app.items i where i.id=t.item_id and i.lot_seq between 997620 and 997624;

set local role authenticated;
do $$declare payload jsonb; begin
  payload := app.read_resource_snapshot('listing_tasks');
  if (select array_agg((r->>'lot_seq')::int order by (r->>'lot_seq')::int)
    from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int between 997610 and 997619)
    is distinct from array[997610,997611,997612,997613,997614,997615]
    then raise exception 'Seven-day tracking rule or listing account coverage incorrect'; end if;
  payload := app.read_resource_snapshot('admin_inspection_tasks');
  if (select array_agg((r->>'lot_seq')::int) from jsonb_array_elements(payload->'rows') r
    where (r->>'lot_seq')::int between 997610 and 997619) is distinct from array[997617]
    then raise exception 'Three-day inspection rule, missing tracking, or recorded inspection incorrect'; end if;
  payload := app.read_resource_snapshot('admin_shipping_tasks');
  if (select count(*) from jsonb_array_elements(payload->'rows') r
    where (r->>'lot_seq')::int between 997620 and 997624)<>4
    or exists(select 1 from jsonb_array_elements(payload->'rows') r where r->>'lot_seq'='997624')
    then raise exception 'Twenty-four-hour shipping rule or shipping account coverage incorrect'; end if;
end $$;

set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare resource text; begin
  if (select count(*) from app.v_delivery_work_tasks where lot_seq between 997610 and 997613 and kind='listing_due')<>4
    or (select count(*) from app.v_delivery_work_tasks where lot_seq between 997620 and 997623 and kind='shipping')<>4
    then raise exception 'Delivery does not include both Mercari and both Yahoo accounts'; end if;
  if exists(select 1 from app.v_admin_work_deadlines) then raise exception 'Management tasks visible to deliverer'; end if;
  foreach resource in array array['listing_tasks','admin_inspection_tasks','admin_shipping_tasks'] loop
    begin perform app.read_resource_snapshot(resource); raise exception 'Deliverer accessed %',resource;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;

set local role postgres;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.items set status='出品中' where lot_seq=997610;
update app.items set inspected_at=now() where lot_seq=997617;
update app.items set shipped_on=current_date where lot_seq=997620;
with plan as (
  insert into app.fba_inbound_plans(account,staff_id,name,created_by,stage)
  select 'FBA2',deliverer_id,'Management deadline fixture','11111111-1111-1111-1111-111111111111','ready'
  from app.items where lot_seq=997614 returning id
)
insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel)
select plan.id,i.id,i.sku,'B000000001',i.title,'良い',i.sales_channel
from plan cross join app.items i where i.lot_seq=997614;

set local role authenticated;
do $$begin
  if exists(select 1 from app.v_admin_work_deadlines where lot_seq in (997610,997614,997617,997620))
    then raise exception 'Completed listing, FBA inbound, inspection, or shipping remains visible'; end if;
end $$;
rollback;
