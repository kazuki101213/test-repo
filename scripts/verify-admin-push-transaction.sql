-- All changes are rolled back; no HTTP dispatcher is invoked.
begin;
do $$
declare item uuid; aa uuid; buyer uuid; adm uuid; del uuid; pur uuid; evt timestamptz; claimed uuid; source uuid; issuer uuid; invoice uuid;
begin
  select id,purchaser_id into item,buyer from app.items where lot_seq=2198 and purchaser_id is not null limit 1;
  select id into aa from app.staff where code='AA';
  select id into buyer from app.staff where is_active and role='purchaser' limit 1;
  if item is null or aa is null then raise exception 'Fixture missing'; end if;
  update app.items set purchaser_id=buyer where id=item;
  insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind) values
    (aa,'https://web.push.apple.com/admin-transaction','fixture','fixture','https://bussan-admin.vercel.app/',now()-interval '1 day','admin') returning id into adm;
  insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind) values
    (aa,'https://web.push.apple.com/delivery-transaction','fixture','fixture','https://test-repo-delivery.vercel.app/',now()-interval '1 day','delivery') returning id into del;
  insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at,app_kind) values
    (buyer,'https://web.push.apple.com/buyer-transaction','fixture','fixture','https://bussan-admin.vercel.app/',now()-interval '1 day','admin') returning id into pur;
  evt:=clock_timestamp();
  update app.items set malfunction_reported=true,malfunction_resolved_at=null,malfunction_reported_at=evt where id=item;
  if not exists(select 1 from app.admin_push_events where staff_id=aa and item_id=item and event_at=evt and kind='malfunction') then raise exception 'Admin report trigger missing'; end if;
  if not exists(select 1 from app.admin_push_events where staff_id=buyer and item_id=item and event_at=evt and kind='malfunction') then raise exception 'Purchaser report trigger missing'; end if;
  select delivery_id into claimed from app.claim_admin_push() where subscription_id=adm and eligible;
  if claimed is null then raise exception 'Admin notification not eligible'; end if;
  if exists(select 1 from app.admin_push_deliveries where subscription_id=del) then raise exception 'Channels mixed'; end if;
  if exists(select 1 from app.claim_admin_push() where subscription_id=adm) then raise exception 'Duplicate lease'; end if;
  perform app.finish_admin_push(claimed,'sent',201);
  evt:=clock_timestamp();
  update app.items set malfunction_reported_at=evt where id=item;
  update app.items set malfunction_resolved_at=clock_timestamp() where id=item;
  if not exists(select 1 from app.claim_admin_push() where subscription_id=adm and not eligible) then raise exception 'Resolved report was eligible'; end if;
  source:=gen_random_uuid();
  insert into app.item_comments(id,item_id,author_id,body,task_kind) values(source,item,aa,'通知のトランザクション検証','ヤフオク その他');
  if not exists(select 1 from app.admin_push_events where source_id=source and kind='action' and staff_id=aa) then raise exception 'Action trigger missing'; end if;
  if exists(select 1 from app.admin_push_events where source_id=source and staff_id=buyer) then raise exception 'Purchaser received admin-only task'; end if;
  update app.item_comments set task_completed_at=clock_timestamp() where id=source;
  if not exists(select 1 from app.claim_admin_push() where subscription_id=adm and task_id=source and not eligible) then raise exception 'Completed action eligible'; end if;
  evt:=clock_timestamp();
  insert into app.photo_reviews(item_id,drive_folder_id,submitted_at,approved_at,exported_photo_count) values(item,'transaction-check',evt,null,1)
    on conflict(item_id) do update set submitted_at=excluded.submitted_at,approved_at=null;
  if not exists(select 1 from app.admin_push_events where item_id=item and event_at=evt and kind='photo_review') then raise exception 'Photo trigger missing'; end if;
  update app.photo_reviews set approved_at=clock_timestamp(),approved_by=aa where item_id=item;
  if not exists(select 1 from app.claim_admin_push() where subscription_id=adm and kind='photo_review' and not eligible) then raise exception 'Approved photo eligible'; end if;
  perform app.claim_delivery_push();
  if exists(select 1 from app.delivery_push_deliveries where subscription_id in (adm,pur)) then raise exception 'Delivery sent to admin subscription'; end if;
  -- Exercise invoice BEFORE-versioning and receipt submission source triggers.
  perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=aa limit 1),true);
  select staff_id into issuer from app.delivery_invoice_profiles where enabled and unit_price is not null limit 1;
  insert into app.delivery_invoices(staff_id,billing_month) values(issuer,'2099-01-01') returning id into invoice;
  if not exists(select 1 from app.admin_push_events where source_id=invoice and kind='invoice' and source_version=1) then raise exception 'Invoice insert trigger missing'; end if;
  update app.delivery_invoices set note='ROLLBACK test' where id=invoice;
  if not exists(select 1 from app.admin_push_events where source_id=invoice and kind='invoice' and source_version=2) then raise exception 'Invoice note update missed BEFORE version'; end if;
  insert into app.invoice_receipts(staff_id,billing_month,storage_path,original_name) values(issuer,'2099-01-01',issuer||'/2099-01/'||gen_random_uuid()||'.jpg','transaction-check.jpg');
  insert into app.invoice_receipt_submissions(staff_id,billing_month) values(issuer,'2099-01-01');
  if not exists(select 1 from app.admin_push_events where invoice_staff_id=issuer and kind='receipts') then raise exception 'Receipt trigger missing'; end if;
  if (select count(*) from app.claim_admin_push() where subscription_id=adm and invoice_staff_id=issuer and eligible)<>1 then raise exception 'Document changes were not consolidated into current task'; end if;
  if has_table_privilege('authenticated','app.admin_push_events','SELECT') or has_function_privilege('anon','app.claim_admin_push()','EXECUTE') then raise exception 'Queue exposed'; end if;
end;
$$;
rollback;
