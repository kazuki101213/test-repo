begin;
create temp table delivery_readers as
select s.id,s.code,s.role,p.user_id,
 (select count(*) from app.items i where s.role='admin' or i.deliverer_id=s.id) expected
from app.staff s join app.profiles p on p.staff_id=s.id
where s.code in ('AA','DD','EE','HH','II','KK','LL','MM') and s.is_active;
grant select on delivery_readers to authenticated;
set local role authenticated;
do $$
declare reader record; actual integer; page_number integer;
begin
 for reader in select * from delivery_readers order by code loop
  perform set_config('request.jwt.claim.sub',reader.user_id::text,true);
  select count(*) into actual from app.v_delivery_tasks;
  if actual<>reader.expected then raise exception '% expected % actual %',reader.code,reader.expected,actual; end if;
  if reader.role<>'admin' and exists(select 1 from app.v_delivery_tasks where deliverer_id is distinct from reader.id) then
   raise exception '% can read another assignee',reader.code;
  end if;
  for page_number in 0..(actual/500) loop
   perform to_jsonb(t) from (select * from app.v_delivery_tasks order by purchased_at desc nulls last,lot_seq desc,id limit 500 offset page_number*500)t;
  end loop;
 end loop;
end $$;
reset role;
set local role anon;
do $$ begin
 begin
  perform * from app.v_delivery_tasks;
  raise exception 'anon access must be denied';
 exception when insufficient_privilege then null;
 end;
end $$;
reset role;
select 'All eight readers, full ordered pages, owner isolation and anon denial passed' as result;
rollback;
