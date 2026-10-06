-- Production regression checks using existing records; not a fresh-database CI fixture.
-- Every change is rolled back. Never remove the rollback.
begin;
do $$
declare
  v_admin uuid; v_deliverer uuid; v_other uuid;
  v_item uuid := '61892662-9437-4d89-8926-348ed017e954';
  v_comment uuid := gen_random_uuid(); v_failed uuid := gen_random_uuid();
  v_reply timestamptz; v_photo timestamptz := clock_timestamp(); v_new_photo timestamptz;
  v_count int;
begin
  select user_id into strict v_admin from app.profiles where staff_id='dcb99339-eaf1-4b6d-abed-39180e30fe93';
  select user_id into strict v_deliverer from app.profiles where staff_id='44015969-9393-4bb1-9bf7-0000f22c94fb';
  select user_id into strict v_other from app.profiles where staff_id='a9e7ecd0-c9a9-4dc6-b2c8-4f535bdfc58f';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated')::text,true);
  assert app.resolve_task_product_id(v_item)='826018963', 'Original product ID must be resolved';
  assert app.resolve_task_product_id('55bd2fea-a1a6-4881-a867-c3da922852ff')='m94624390123', 'Own ID must be retained';
  assert not has_function_privilege('anon','app.mark_item_notices_read(uuid,timestamptz,timestamptz)','EXECUTE'), 'Anonymous read acknowledgement';
  assert not has_function_privilege('anon','app.send_malfunction_reply(uuid,uuid,text,text,text[])','EXECUTE'), 'Anonymous reply';
  assert not has_table_privilege('authenticated','app.item_notice_reads','INSERT'), 'Direct arbitrary read writes';
  update app.items set sales_channel='FBA',malfunction_resolved_at=null,malfunction_resolved_by=null where id=v_item;
  begin
    perform app.send_malfunction_reply(v_failed,v_item,'transaction rollback test','Panasonic◯ヤフオク',
      array['2198a-II-18991230-0/reply/'||v_failed||'/1.jpg','2198a-II-18991230-0/reply/'||v_failed||'/1.jpg']);
    raise exception 'Duplicate photo paths should fail';
  exception when unique_violation then null;
  end;
  assert not exists(select 1 from app.item_comments where id=v_failed), 'Failed reply must roll back';
  assert (select sales_channel::text='FBA' and malfunction_resolved_at is null from app.items where id=v_item), 'Failed reply must not resolve or change channel';
  perform app.send_malfunction_reply(v_comment,v_item,'transaction test','Panasonic◯ヤフオク','{}');
  assert (select sales_channel::text='ヤフオク' and malfunction_resolved_at is not null from app.items where id=v_item), 'Reply must resolve and change channel';
  perform app.send_malfunction_reply(v_comment,v_item,'transaction test','Panasonic◯ヤフオク','{}');
  select count(*) into v_count from app.item_comments where id=v_comment;
  assert v_count=1, 'Idempotent retry';
  select created_at into v_reply from app.item_comments where id=v_comment;
  insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,approved_at,approved_by)
    values(v_item,'transaction-only-test',1,v_photo,'dcb99339-eaf1-4b6d-abed-39180e30fe93')
    on conflict(item_id) do update set approved_at=excluded.approved_at;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_other,'role','authenticated')::text,true);
  assert not exists(select 1 from app.list_delivery_item_notices() where item_id=v_item), 'Another deliverer must not see notices';
  begin
    perform app.mark_item_notices_read(v_item,v_reply,v_photo);
    raise exception 'Other deliverer should be blocked';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_deliverer,'role','authenticated')::text,true);
  assert exists(select 1 from app.list_delivery_item_notices() where item_id=v_item and reply_at is not null and photo_at is not null), 'Both notices must be visible';
  perform app.mark_item_notices_read(v_item,v_reply,v_photo);
  assert not exists(select 1 from app.list_delivery_item_notices() where item_id=v_item), 'Opening detail acknowledges both notices';
  assert not exists(select 1 from app.item_notice_reads where item_id=v_item and staff_id='a9e7ecd0-c9a9-4dc6-b2c8-4f535bdfc58f'), 'No other staff read state modified';
  v_new_photo := v_photo+interval '1 second';
  update app.photo_reviews set approved_at=v_new_photo where item_id=v_item;
  assert exists(select 1 from app.list_delivery_item_notices() where item_id=v_item and photo_at=v_new_photo and reply_at is null), 'Reapproval creates fresh notice';
  perform set_config('request.jwt.claims','{}',true);
  assert not exists(select 1 from app.list_delivery_item_notices()), 'Unauthenticated users see no notices';
end $$;
rollback;
select 'transactional regression checks passed; all changes rolled back' as result;
