begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,asin,planned_price,condition)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'Amazon reconciliation fixture',1000,'ヤフオク','自己発送2','fixture',now(),'B015INS3IE',390,'非常に良い' from unnest(array[997851,997852])n;
insert into app.item_photos(item_id,storage_path) select id,'test/reconcile-'||lot_seq||'.jpg' from app.items where lot_seq in (997851,997852);
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at) select id,'fixture',1,now() from app.items where lot_seq in (997851,997852);
insert into app.amazon_listing_submissions(request_id,item_id,requested_by,sku,asin,sales_channel,account_id,seller_id,price,item_condition,description,work_completed_on,state,verified_at,photo_ids,photo_fingerprint,photos_verified_at)
select case when i.lot_seq=997851 then '99785100-0000-4000-8000-000000000001'::uuid else '99785200-0000-4000-8000-000000000001'::uuid end,i.id,
 (select user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),i.sku,i.asin,i.sales_channel,'amazon-2','A3E7BXJWH9TP11',390,i.condition::text,coalesce(i.description,''),current_date-1,'verified',now(),array[(select id from app.item_photos p where p.item_id=i.id)],'fixture-content-fingerprint',now() from app.items i where lot_seq in (997851,997852);
-- A legitimate cost edit creates an inventory SKU and retains the Amazon SKU alias.
update app.items set cost_amount=1200 where lot_seq=997851;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 begin perform app.complete_verified_amazon_listing('99785100-0000-4000-8000-000000000001',(select sku from app.items where lot_seq=997851));raise exception 'User invoked service finalizer';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local request.jwt.claim.role='service_role';
-- First reject stale, foreign-photo and unverified evidence without changing inventory.
update app.amazon_listing_submissions set verified_at=null where item_id=(select id from app.items where lot_seq=997851);
do $$begin
 begin perform app.complete_verified_amazon_listing('99785100-0000-4000-8000-000000000001',(select sku from app.items where lot_seq=997851));raise exception 'Null verification accepted';exception when insufficient_privilege then null;end;
end $$;
update app.amazon_listing_submissions set verified_at=now(),photo_ids=array[(select id from app.item_photos where item_id=(select id from app.items where lot_seq=997852))] where item_id=(select id from app.items where lot_seq=997851);
do $$begin
 begin perform app.complete_verified_amazon_listing('99785100-0000-4000-8000-000000000001',(select sku from app.items where lot_seq=997851));raise exception 'Foreign photo accepted';exception when insufficient_privilege then null;end;
end $$;
update app.amazon_listing_submissions set photo_ids=array[(select id from app.item_photos where item_id=(select id from app.items where lot_seq=997851))] where item_id=(select id from app.items where lot_seq=997851);
select set_config('test.amazon_expected_sku',(select sku from app.items where lot_seq=997851),true);
set local role service_role;
select app.complete_verified_amazon_listing('99785100-0000-4000-8000-000000000001',current_setting('test.amazon_expected_sku'));
select app.complete_verified_amazon_listing('99785100-0000-4000-8000-000000000001',current_setting('test.amazon_expected_sku'));
reset role;
do $$begin
 if not exists(select 1 from app.items where lot_seq=997851 and status='出品中' and packed_on=current_date-1 and product_registered_at is not null and sku like '%-120') then raise exception 'Alias listing or saved work date not finalized';end if;
 if (select count(*) from app.inventory_workflow_events where id='99785100-0000-4000-8000-000000000001')<>1 then raise exception 'Duplicate workflow event';end if;
 if has_function_privilege('anon','app.complete_verified_amazon_listing(uuid,text)','execute') or has_function_privilege('authenticated','app.complete_verified_amazon_listing(uuid,text)','execute') then raise exception 'Finalizer permission widened';end if;
end $$;
rollback;
