-- Production-data regression checks. All mutations are rolled back; no HTTP kick.
begin;
do $$
declare item uuid; staff_ii uuid; staff_aa uuid; staff_dd uuid; sub uuid; delivery uuid; at_time timestamptz; actual integer;
begin
  select id into item from app.items where lot_seq=2198 and malfunction_reported_at is not null and deliverer_id=(select id from app.staff where code='II') limit 1;
  select id into staff_ii from app.staff where code='II';
  select id into staff_aa from app.staff where code='AA';
  select id into staff_dd from app.staff where code='DD';
  if item is null then raise exception 'Required regression fixture is unavailable'; end if;
  insert into app.delivery_push_subscriptions(staff_id,endpoint,p256dh,auth,base_url,created_at)
    values(staff_ii,'https://web.push.apple.com/transaction-check','fixture','fixture','https://test-repo-delivery.vercel.app/',now()-interval '1 day') returning id into sub;
  at_time:=clock_timestamp();
  perform app.enqueue_delivery_push(item,'reply',at_time,staff_aa);
  perform app.enqueue_delivery_push(item,'reply',at_time,staff_aa);
  select count(*) into actual from app.delivery_push_events where item_id=item and kind='reply' and event_at=at_time;
  if actual<>1 then raise exception 'Wrong recipient or duplicate event: %',actual; end if;
  select delivery_id into delivery from app.claim_delivery_push() where subscription_id=sub and eligible;
  if delivery is null then raise exception 'Eligible notification not claimed'; end if;
  select count(*) into actual from app.claim_delivery_push() where subscription_id=sub;
  if actual<>0 then raise exception 'Lease did not prevent a simultaneous send'; end if;
  perform app.finish_delivery_push(delivery,'sent',201);
  select count(*) into actual from app.claim_delivery_push() where subscription_id=sub;
  if actual<>0 then raise exception 'Already sent event claimed twice'; end if;
  -- A confirmed reply must be cancelled instead of pushed.
  at_time:=clock_timestamp();
  perform app.enqueue_delivery_push(item,'reply',at_time,staff_aa);
  insert into app.item_notice_reads(item_id,staff_id,reply_read_at) values(item,staff_ii,at_time)
    on conflict(item_id,staff_id) do update set reply_read_at=excluded.reply_read_at;
  select delivery_id into delivery from app.claim_delivery_push() where subscription_id=sub and not eligible;
  if delivery is null then raise exception 'Read reply not cancelled'; end if;
  perform app.finish_delivery_push(delivery,'cancelled',null);
  -- Replies from another account cannot follow the item to its previous assignee.
  at_time:=clock_timestamp();
  perform app.enqueue_delivery_push(item,'reply',at_time,staff_aa);
  update app.items set deliverer_id=staff_dd where id=item;
  if not exists(select 1 from app.delivery_push_events where item_id=item and staff_id=staff_dd and kind='assigned') then
    raise exception 'Assignment trigger did not enqueue new assignee';
  end if;
  select delivery_id into delivery from app.claim_delivery_push() where subscription_id=sub and not eligible;
  if delivery is null then raise exception 'Old assignee remained eligible'; end if;
  perform app.finish_delivery_push(delivery,'cancelled',null);
  -- Subscription activation does not backfill old tasks.
  update app.delivery_push_subscriptions set created_at=clock_timestamp() where id=sub;
  select count(*) into actual from app.claim_delivery_push() where subscription_id=sub;
  if actual<>0 then raise exception 'Old events backfilled'; end if;
  -- Verify real source-table triggers, not only the queue helper.
  insert into app.item_comments(id,item_id,author_id,body,created_at)
    values(gen_random_uuid(),item,staff_aa,'通知トリガーの検証（ROLLBACK）',now());
  if not exists(select 1 from app.delivery_push_events where item_id=item and staff_id=staff_dd and kind='reply' and event_at=now()) then
    raise exception 'Reply trigger did not enqueue';
  end if;
  at_time:=clock_timestamp();
  insert into app.photo_reviews(item_id,drive_folder_id,approved_at,approved_by,submitted_at,exported_photo_count)
    values(item,'transaction-check',at_time,staff_aa,now(),1)
    on conflict(item_id) do update set approved_at=excluded.approved_at,approved_by=excluded.approved_by;
  if not exists(select 1 from app.delivery_push_events where item_id=item and staff_id=staff_dd and kind='photo' and event_at=at_time) then
    raise exception 'Photo approval trigger did not enqueue';
  end if;
  if has_table_privilege('authenticated','app.delivery_push_subscriptions','SELECT')
    or has_function_privilege('authenticated','app.delivery_push_config()','EXECUTE')
    or has_function_privilege('anon','app.claim_delivery_push()','EXECUTE') then
    raise exception 'Push subscriptions/keys/dispatcher exposed';
  end if;
end;
$$;
rollback;
