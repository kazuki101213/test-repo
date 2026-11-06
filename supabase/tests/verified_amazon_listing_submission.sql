-- Disposable tests only: no Amazon calls or real marketplace operations.
begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,asin,planned_price,condition)
select 997850,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-5,'verified listing test',1000,'ヤフオク','FBA2','fixture',now(),'B015INS3IE',400,'非常に良い';
insert into app.item_photos(item_id,storage_path) select id,'test/verified-listing.jpg' from app.items where lot_seq=997850;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at) select id,'fixture',1,now() from app.items where lot_seq=997850;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare i uuid:=(select id from app.items where lot_seq=997850);begin
 begin perform app.perform_dated_inventory_action(i,'listing_complete','商品登録前',current_date,gen_random_uuid());raise exception 'Unverified listing accepted';exception when insufficient_privilege then null;end;
 if exists(select 1 from app.items where id=i and (status<>'商品登録前' or packed_on is not null or product_registered_at is not null)) then raise exception 'Unverified completion changed inventory or billing';end if;
 begin insert into app.amazon_listing_submissions(request_id,item_id) values(gen_random_uuid(),i);raise exception 'Assignee forged verification';exception when insufficient_privilege then null;end;
end $$;
reset role;
insert into app.amazon_listing_submissions(request_id,item_id,requested_by,sku,asin,sales_channel,account_id,seller_id,price,item_condition,description,work_completed_on,state,verified_at)
select '99785000-0000-4000-8000-000000000001',i.id,(select user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),i.sku,i.asin,i.sales_channel,'amazon-2','A3E7BXJWH9TP11',400,i.condition::text,coalesce(i.description,''),current_date,'accepted',null from app.items i where lot_seq=997850;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 begin perform app.perform_dated_inventory_action((select id from app.items where lot_seq=997850),'listing_complete','商品登録前',current_date,'99785000-0000-4000-8000-000000000001');raise exception 'Accepted is not verified';exception when insufficient_privilege then null;end;
end $$;
reset role;
update app.amazon_listing_submissions set state='verified',verified_at=clock_timestamp(),seller_id='A1WI3OGPE43N2T' where request_id='99785000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 begin perform app.perform_dated_inventory_action((select id from app.items where lot_seq=997850),'listing_complete','商品登録前',current_date,'99785000-0000-4000-8000-000000000001');raise exception 'Wrong seller evidence accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
update app.amazon_listing_submissions set seller_id='A3E7BXJWH9TP11' where request_id='99785000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin if exists(select 1 from app.amazon_listing_submissions where request_id='99785000-0000-4000-8000-000000000001') then raise exception 'Other assignee read submission';end if;end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_dated_inventory_action(id,'listing_complete',status,current_date,'99785000-0000-4000-8000-000000000001') from app.items where lot_seq=997850;
do $$begin
 if not exists(select 1 from app.items where lot_seq=997850 and status='出品中' and packed_on=current_date and product_registered_at is not null) then raise exception 'Verified listing was not finalized';end if;
 if has_table_privilege('authenticated','app.amazon_listing_submissions','INSERT') or has_table_privilege('anon','app.amazon_listing_submissions','SELECT') then raise exception 'Submission write permission widened';end if;
end $$;
rollback;
