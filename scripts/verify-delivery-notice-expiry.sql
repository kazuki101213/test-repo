-- All source/queue/read mutations roll back; no HTTP dispatcher is called.
begin;
do $$
declare
  item uuid; author uuid; reader uuid; reader_user uuid; comment_id uuid := gen_random_uuid();
  cutoff timestamptz := now() - interval '72 hours';
  reply_time timestamptz; photo_time timestamptz; row_record record; scenario integer;
begin
  select id into strict author from app.staff where code='AA';
  select s.id,p.user_id into strict reader,reader_user
    from app.staff s join app.profiles p on p.staff_id=s.id where s.code='II';
  select id into strict item from app.items where lot_seq=2198 and not is_accessory and deliverer_id=reader and sku ~ '^2198-';
  perform set_config('request.jwt.claim.sub',reader_user::text,true);
  update app.item_comments set created_at=now()-interval '5 days' where item_id=item;
  update app.items set malfunction_reported_at=now()-interval '4 days' where id=item;
  insert into app.item_notice_reads(staff_id,item_id,reply_read_at,photo_read_at)
    values(reader,item,null,null) on conflict(staff_id,item_id)
    do update set reply_read_at=null,photo_read_at=null;
  insert into app.item_comments(id,item_id,author_id,body,created_at)
    values(comment_id,item,author,'3日通知期限の検証（ROLLBACK）',cutoff+interval '1 microsecond');
  insert into app.photo_reviews(item_id,drive_folder_id,approved_at,approved_by,submitted_at,exported_photo_count)
    values(item,'transaction-check',cutoff+interval '1 microsecond',author,now()-interval '4 days',1)
    on conflict(item_id) do update set approved_at=excluded.approved_at,approved_by=excluded.approved_by;
  for scenario in 1..5 loop
    reply_time := case when scenario in (1,4) then cutoff+interval '1 microsecond'
      when scenario=2 then cutoff else cutoff-interval '1 microsecond' end;
    photo_time := case when scenario in (1,5) then cutoff+interval '1 microsecond'
      when scenario=2 then cutoff else cutoff-interval '1 microsecond' end;
    update app.item_comments set created_at=reply_time where id=comment_id;
    update app.photo_reviews set approved_at=photo_time where item_id=item;
    set local role authenticated;
    select * into row_record from app.list_delivery_item_notices() where item_id=item;
    if scenario in (2,3) then
      if found then raise exception 'Expired notice still visible at boundary, scenario %',scenario; end if;
    else
      if not found or row_record.reply_at is distinct from (case when scenario in (1,4) then reply_time end)
        or row_record.photo_at is distinct from (case when scenario in (1,5) then photo_time end)
        then raise exception 'Independent expiry failed, scenario %',scenario; end if;
    end if;
    reset role;
  end loop;
  set local role authenticated;
  perform app.mark_item_notices_read(item,null,photo_time);
  if exists(select 1 from app.list_delivery_item_notices() where item_id=item) then
    raise exception 'Opening detail no longer acknowledges current notice';
  end if;
  reset role;
  if not exists(select 1 from app.item_comments where id=comment_id)
    or not exists(select 1 from app.photo_reviews where item_id=item) then
    raise exception 'Expiry removed source history';
  end if;
  if has_function_privilege('anon','app.list_delivery_item_notices()','EXECUTE') then
    raise exception 'Anonymous access granted';
  end if;
end $$;
select 'Before/exactly/after 72h, independent kinds, acknowledgement, history and permissions passed' as result;
rollback;
