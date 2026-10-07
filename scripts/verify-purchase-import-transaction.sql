begin;
select set_config('request.jwt.claims',jsonb_build_object('sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active order by p.user_id limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare r jsonb; c jsonb; p jsonb; v_id text:='m99999990000000000001'; v_count int; v_day date:=(now() at time zone 'Asia/Tokyo')::date;
begin
  assert app.is_admin();
  assert not has_function_privilege('anon','app.marketplace_purchase_import(text,text,jsonb)','execute');
  c:=app.marketplace_purchase_context('メルカリ');
  assert c->>'day'=v_day::text;
  p:=jsonb_build_object('marketplace_item_id',v_id,'marketplace_url','https://jp.mercari.com/item/'||v_id,'title','購入取り込みロールバック検証','purchased_at',v_day,'cost_amount',1234);
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p));assert (r->>'inserted')::int=1,'valid purchase inserted';
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p));assert (r->>'inserted')::int=0 and (r->>'skipped')::int=1,'duplicate skipped';
  update app.marketplace_purchase_drafts set state='dismissed' where marketplace_item_id=v_id;
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p));assert (r->>'skipped')::int=1,'dismissed stays excluded';
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p||jsonb_build_object('marketplace_item_id','m99999990000000000002','purchased_at','2020-01-01')));assert (r->>'rejected')::int=1,'old date rejected';
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p||jsonb_build_object('marketplace_item_id','m99999990000000000003','purchased_at','2026-02-30')));assert (r->>'rejected')::int=1,'invalid date rejected';
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p||jsonb_build_object('marketplace_item_id','m99999990000000000004','purchased_at',null)));assert (r->>'rejected')::int=1,'unknown date rejected';
  r:=app.marketplace_purchase_import('メルカリ','テスト',jsonb_build_array(p||jsonb_build_object('marketplace_item_id','m99999990000000000005','marketplace_url','https://evil.test/')));assert (r->>'rejected')::int=1,'external url rejected';
  c:=app.marketplace_purchase_context('メルカリ');assert c->'knownIds' ? v_id;
  perform set_config('request.jwt.claims','{}',true);
  begin perform app.marketplace_purchase_context('メルカリ');raise exception 'missing admin check';exception when raise_exception then if sqlerrm='missing admin check' then raise;end if;end;
end $$;
reset role;
select 'purchase import authenticated checks passed; rollback follows' as result;
rollback;
