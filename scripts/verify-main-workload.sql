begin;
select set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA'),true);
set local role authenticated;
do $$
declare w record; actual_count bigint; actual_average numeric;
 today date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',now() at time zone 'Asia/Tokyo')::date;
begin
 for w in select * from app.v_deliverer_workload loop
  select count(*) into actual_count from app.items where deliverer_id=w.deliverer_id and not is_accessory and status='作業中';
  if actual_count<>w."作業中" then raise exception 'Working count mismatch'; end if;
  select count(*) into actual_count from app.items where deliverer_id=w.deliverer_id and not is_accessory and packed_on is null;
  if actual_count<>w."梱包前" then raise exception 'Packed detail count mismatch'; end if;
  select count(*) into actual_count from app.items where deliverer_id=w.deliverer_id and not is_accessory and shipped_on>=month_start and shipped_on<=today;
  if actual_count<>w."出荷済" then raise exception 'Shipped detail count mismatch'; end if;
  select round(avg(packed_on-purchased_at),1) into actual_average from app.items where deliverer_id=w.deliverer_id and not is_accessory and purchased_at is not null and packed_on>=(today-interval '3 months')::date and packed_on<=today;
  if actual_average is distinct from w."平均作業日数" then raise exception 'Average detail mismatch'; end if;
 end loop;
end $$;
reset role;
select 'Authenticated dashboard and main-only detail counts/packed-date averages match for every active assignee' as result;
rollback;
