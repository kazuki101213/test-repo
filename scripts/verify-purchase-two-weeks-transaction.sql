begin;
select set_config('request.jwt.claims',jsonb_build_object('sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active order by p.user_id limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare c jsonb; r jsonb; p jsonb; d date:=(now() at time zone 'Asia/Tokyo')::date; v_test_id text:='m99999990000000000011';
begin
c:=app.marketplace_purchase_context('メルカリ');assert (c->>'cutoff')::date=d-14;assert jsonb_typeof(c->'inventoryIds')='array';
p:=jsonb_build_object('marketplace_item_id',v_test_id,'marketplace_url','https://jp.mercari.com/item/'||v_test_id,'title','2週間取得ROLLBACK検証','purchased_at',d-14,'cost_amount',null);
r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p));assert (r->>'inserted')::int=1;
c:=app.marketplace_purchase_context('メルカリ');assert c->'knownIds' ? v_test_id;
r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p||jsonb_build_object('cost_amount',999)));assert (r->>'skipped')::int=1;
assert (select cost_amount is null from app.marketplace_purchase_drafts where marketplace_item_id=v_test_id);
update app.marketplace_purchase_drafts set state='dismissed' where marketplace_item_id=v_test_id and state='draft';assert found;
assert (select state='dismissed' from app.marketplace_purchase_drafts where marketplace_item_id=v_test_id);
r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p));assert (r->>'skipped')::int=1;
r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p||jsonb_build_object('purchased_at',d-15)));assert (r->>'rejected')::int=1;
assert not has_function_privilege('anon','app.marketplace_purchase_import(text,text,jsonb)','execute');
end $$;
reset role;
select '2-week boundary, imported null-price exclusion, dismiss update, duplicate protection passed' as result;
rollback;
