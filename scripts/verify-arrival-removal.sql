-- Run after the migration. Everything is rolled back; no notifications are sent.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
create temporary table test_users on commit drop as
select s.code,p.user_id from app.staff s join app.profiles p on p.staff_id=s.id
where s.code in ('AA','II');
create temporary table work_fixture on commit drop as
select i.id,i.purchased_at,i.deliverer_id from app.items i join app.staff s on s.id=i.deliverer_id
where s.code='II' and not i.is_accessory and i.status='作業中'
  and i.packed_on is null and i.shipped_on is null order by i.id limit 1;
create temporary table other_fixture on commit drop as
select i.id from app.items i join app.staff s on s.id=i.deliverer_id
where s.code='LL' and not i.is_accessory order by i.id limit 1;
create temporary table orphan_fixture on commit drop as
select i.id,to_jsonb(i) as value from app.items i where i.is_accessory and i.status='販売済'
  and i.packed_on is null and i.shipped_on is null and i.sold_on is not null
  and not exists(select 1 from app.items b where not b.is_accessory and b.lot_seq=i.lot_seq
  and app.product_serial(b.sku,b.lot_seq)=app.product_serial(i.sku,i.lot_seq)) limit 1;
grant select on test_users,work_fixture,other_fixture,orphan_fixture to authenticated;
grant select on work_fixture to anon;
do $$ begin
 if (select count(*) from work_fixture)<>1 or (select count(*) from orphan_fixture)<>1
   or (select count(*) from other_fixture)<>1 then raise exception 'Missing test fixture';end if;
 if exists(select 1 from information_schema.columns where table_schema='app' and column_name='arrived_on')
   or exists(select 1 from pg_views where schemaname='app' and definition like '%arrived_on%')
   or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='app' and p.prokind='f' and pg_get_functiondef(p.oid) like '%arrived_on%')
 then raise exception 'Arrival dependency remains';end if;
end $$;
select set_config('request.jwt.claim.sub',(select user_id::text from test_users where code='AA'),true);
set local role authenticated;
-- Workload totals and averages must match an independent source aggregation.
do $$ begin
 if exists(select 1 from app.v_deliverer_workload w join lateral (
   select count(*) filter(where i.status='作業中') as working,
     avg(i.shipped_on-i.purchased_at) filter(where i.shipped_on is not null
       and i.purchased_at is not null)::numeric(10,1) as days
   from app.items i where i.deliverer_id=w.deliverer_id
 ) e on true where w.作業中<>e.working or w.手元在庫<>e.working
   or w.平均作業日数 is distinct from e.days) then raise exception 'Workload mismatch';end if;
 -- Narrow standalone-date exception: administrator fills blanks only.
 begin
   update app.items set packed_on=sold_on-21,shipped_on=sold_on-21 where id=(select id from orphan_fixture);
   if exists(select 1 from app.items i join orphan_fixture f using(id) where
     (to_jsonb(i)-array['packed_on','shipped_on','packed_completed_at','updated_at'])
       is distinct from (f.value-array['packed_on','shipped_on','packed_completed_at','updated_at']))
   then raise exception 'Orphan non-date data changed';end if;
   begin
     update app.items set shipped_on=shipped_on+1 where id=(select id from orphan_fixture);
     raise exception 'Existing orphan date overwrite allowed' using errcode='P9002';
   exception when sqlstate 'P0001' then null;end;
   begin
     update app.items set sold_price=1 where id=(select id from orphan_fixture);
     raise exception 'Orphan sale edit allowed' using errcode='P9002';
   exception when sqlstate 'P0001' then null;end;
   raise exception 'Rollback orphan test' using errcode='P9001';
 exception when sqlstate 'P9001' then null;end;
end $$;
select set_config('request.jwt.claim.sub',(select user_id::text from test_users where code='II'),true);
do $$ declare row app.items; changed integer; begin
 begin
   update app.items set packed_on=sold_on-21,shipped_on=sold_on-21 where id=(select id from orphan_fixture);
   get diagnostics changed=row_count;
   if changed>0 then raise exception 'Non-admin orphan date edit allowed' using errcode='P9002';end if;
 exception when sqlstate 'P0001' then null;end;
 row:=app.set_delivery_progress((select id from work_fixture),'inspection_cleaning',true);
 if row.inspected_at is null or row.cleaned_at is null or row.status<>'作業中' then raise exception 'Inspection failed';end if;
 row:=app.set_delivery_progress((select id from work_fixture),'listing',true);
 if row.product_registered_at is null or row.photo_uploaded_at is null then raise exception 'Listing failed';end if;
 row:=app.set_work_progress((select id from work_fixture),'photo',true);
 if row.photo_uploaded_at is null then raise exception 'Legacy photo flow failed';end if;
 begin
   perform app.set_work_progress((select id from work_fixture),'arrived',true);
   raise exception 'Legacy arrival accepted' using errcode='P9002';
 exception when sqlstate '22023' then null;end;
 begin
   perform app.set_delivery_progress((select id from other_fixture),'inspection_cleaning',true);
   raise exception 'Other owner accepted' using errcode='P9002';
 exception when sqlstate '42501' then null;end;
end $$;
select set_config('request.jwt.claim.sub',(select user_id::text from test_users where code='AA'),true);
do $$ declare row app.items; begin
 row:=app.set_delivery_progress((select id from work_fixture),'packed',true,current_date-1);
 if row.packed_on<>current_date-1 or row.status<>'作業中' then raise exception 'Packing failed';end if;
 row:=app.set_delivery_progress((select id from work_fixture),'shipped',true,current_date);
 if row.shipped_on<>current_date or row.status<>'出品中'
   or row.purchased_at is distinct from (select purchased_at from work_fixture) then raise exception 'Shipping failed';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ begin
 begin
   perform app.set_delivery_progress((select id from work_fixture),'inspection_cleaning',true);
   raise exception 'Anonymous progress accepted' using errcode='P9002';
 exception when sqlstate '42501' then null;end;
end $$;
reset role;
select 'Arrival removed; work steps, legacy photo, ownership, standalone date guard and workload calculations passed' as result;
rollback;
