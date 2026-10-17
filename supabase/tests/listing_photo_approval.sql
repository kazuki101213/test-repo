begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select 993101,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'listing approval regression',1000,'ヤフオク','FBA','123',now();
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare item uuid:=(select id from app.items where lot_seq=993101);begin
 if app.listing_photos_approved(item) then raise exception 'Missing review approved';end if;
 begin perform app.perform_inventory_action(item,'listing_complete','商品登録前');raise exception 'Unapproved FBA listing accepted';exception when insufficient_privilege then null;end;
end $$;
set local role postgres;
insert into app.item_photos(item_id,storage_path) select id,'test/approval-product.jpg' from app.items where lot_seq=993101;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count) select id,'fixture-folder',1 from app.items where lot_seq=993101;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select app.approve_photo_review(id) from app.items where lot_seq=993101;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare item uuid:=(select id from app.items where lot_seq=993101);begin
 if not app.listing_photos_approved(item) then raise exception 'Approval invisible to assignee';end if;
 if not (select photo_review_approved from app.v_delivery_tasks where id=item) then raise exception 'View approval missing';end if;
 if not (app.seller_operation_context(item)->>'photo_review_approved')::boolean then raise exception 'Context approval missing';end if;
 perform app.perform_inventory_action(item,'listing_complete','商品登録前');
 perform app.perform_inventory_action(item,'listing_cancel','出品中','fixture not actually listed');
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.items set sales_channel='メルカリ' where lot_seq=993101;
create temporary table approval_probe as select id,jsonb_build_object('expected_revision',updated_at,'title','test','description','description','price',1000,'condition','目立った傷や汚れなし','origin','千葉県','shippingMethod','らくらくメルカリ便','photos',jsonb_build_array('https://xgoppuqoqeppckyunnvx.supabase.co/storage/v1/object/sign/item-photos/test.jpg')) payload,gen_random_uuid() request from app.items where lot_seq=993101;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.queue_seller_operation(id,'listing',payload,request) from approval_probe;
-- Upload invalidates approval even if the listing was queued earlier.
insert into app.item_photos(item_id,storage_path) select id,'test/approval-added.jpg' from approval_probe;
do $$declare item uuid:=(select id from approval_probe);begin
 if app.listing_photos_approved(item) then raise exception 'Changed photos stayed approved';end if;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare probe approval_probe;begin select * into probe from approval_probe;
 if app.extension_claim_seller_operation(probe.request,'mercari-2') then raise exception 'Worker claimed invalidated photos';end if;
 if (select status from app.seller_operations where id=probe.request)<>'failed' then raise exception 'Invalidated queue not stopped';end if;
 begin perform app.queue_seller_operation(probe.id,'listing',probe.payload,gen_random_uuid());raise exception 'Admin bypassed photo approval';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$declare item uuid:=(select id from approval_probe);begin
 if app.listing_photos_approved(item) then raise exception 'Other assignee saw approval';end if;
 if exists(select 1 from app.v_delivery_tasks where id=item) then raise exception 'View bypassed RLS';end if;
end $$;
rollback;
