begin;
select set_config('request.jwt.claims',json_build_object('sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active order by p.user_id limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $$ declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();
begin
 delete from app.marketplace_purchase_leases where marketplace in ('メルカリ','ヤフオク');
 assert app.marketplace_purchase_lease('メルカリ',a,'acquire') is true;
 assert app.marketplace_purchase_lease('メルカリ',b,'acquire') is not true;
 assert app.marketplace_purchase_lease('ヤフオク',b,'acquire') is true;
 perform app.marketplace_purchase_lease('メルカリ',b,'release');
 assert app.marketplace_purchase_lease('メルカリ',b,'acquire') is not true;
 perform app.marketplace_purchase_lease('メルカリ',a,'release');
 assert app.marketplace_purchase_lease('メルカリ',b,'acquire') is true;
 update app.marketplace_purchase_leases set expires_at=now()-interval '1 second' where marketplace='メルカリ';
 assert app.marketplace_purchase_lease('メルカリ',a,'acquire') is true;
 assert not has_function_privilege('anon','app.marketplace_purchase_lease(text,uuid,text)','execute');
end $$;
select 'site lease contention, independent site, wrong-owner release, expiry, anon denial verified' as result;
rollback;