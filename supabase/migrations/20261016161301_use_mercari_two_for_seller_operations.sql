-- Keep purchase/tracking identities unchanged; only the seller account changes.
do $$declare signature text;definition text;begin
 perform set_config('lock_timeout','5s',true);
 lock table app.seller_listings, app.seller_operations in share row exclusive mode;
 if exists(select 1 from app.seller_listings where account_id='mercari-1' and active)
 or exists(select 1 from app.seller_operations where account_id='mercari-1' and status in ('queued','running','uncertain')) then
  raise exception 'メルカリ1の未完了操作・出品の紐付けを確認してから連携先を変更してください';
 end if;
-- Retain the old account value for historical records; new requests use account 2.
alter table app.seller_listings drop constraint seller_listings_account_id_check;
alter table app.seller_listings add constraint seller_listings_account_id_check
 check(account_id in ('mercari-1','mercari-2','auctions-1'));
 foreach signature in array array[
  'app.queue_seller_operation(uuid,text,jsonb,uuid)',
  'app.sync_seller_observation(text,jsonb)',
  'app.seller_sync_context(text[])'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if strpos(definition,'''mercari-1''')=0 then raise exception 'Expected seller account mapping was not found: %',signature;end if;
  execute replace(definition,'''mercari-1''','''mercari-2''');
 end loop;
end $$;
notify pgrst,'reload schema';
