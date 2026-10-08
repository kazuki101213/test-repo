-- Validate the final schema and listing flow. All changes are rolled back.
begin;
set local statement_timeout='120s';
create temporary table listing_test_users on commit drop as
select s.code,s.id as staff_id,p.user_id from app.staff s join app.profiles p on p.staff_id=s.id where s.code in ('AA','II');
create temporary table listing_test_fixtures on commit drop as
select 'photo'::text as kind,i.id from app.items i join app.staff s on s.id=i.deliverer_id
where s.code='II' and not i.is_accessory and i.status='作業中' and i.shipped_on is null
 and exists(select 1 from app.item_photos p where p.item_id=i.id) order by i.id limit 1;
insert into listing_test_fixtures select 'other',i.id from app.items i join app.staff s on s.id=i.deliverer_id where s.code='LL' and not i.is_accessory order by i.id limit 1;
insert into listing_test_fixtures select 'working_return',id from app.items where marketplace='動作品Amazon返品' and not is_accessory order by id limit 1;
insert into listing_test_fixtures select 'no_photo',i.id from app.items i join app.staff s on s.id=i.deliverer_id where s.code='II' and not i.is_accessory and not exists(select 1 from app.item_photos p where p.item_id=i.id) order by i.id limit 1;
grant select on listing_test_users,listing_test_fixtures to authenticated,anon;
create temporary table preserved_listing_photos on commit drop as select id,to_jsonb(p) as value from app.item_photos p;
create temporary table preserved_listing_reviews on commit drop as select item_id,to_jsonb(r) as value from app.photo_reviews r;
do $$ begin
 if (select count(*) from listing_test_fixtures)<>4 then raise exception 'Missing listing fixtures';end if;
 if (select array_agg(enumlabel::text order by enumsortorder) from pg_enum where enumtypid='app.item_status'::regtype)
   <>array['作業中','出品中','販売済','返品処理'] then raise exception 'Incorrect enum labels';end if;
 if to_regprocedure('app.set_work_progress(uuid,text,boolean)') is not null then raise exception 'Legacy work RPC remains';end if;
 if exists(select 1 from information_schema.columns where table_schema='app' and column_name='arrived_on') then raise exception 'Arrival column returned';end if;
 if exists(select 1 from pg_constraint where conrelid='app.items'::regclass and conname in ('items_no_hold_or_discard','items_no_retired_purchase_status','items_no_amazon_return_work_status')) then raise exception 'Legacy constraints remain';end if;
 if has_function_privilege('anon','app.set_delivery_listing_progress(uuid,boolean)','EXECUTE')
   or has_function_privilege('public','app.set_delivery_listing_progress(uuid,boolean)','EXECUTE') then raise exception 'Public listing RPC access';end if;
end $$;
select set_config('request.jwt.claim.sub',(select user_id::text from listing_test_users where code='AA'),true);
set local role authenticated;
update app.items set product_registered_at=null,photo_uploaded_at=null where id=(select id from listing_test_fixtures where kind='photo');
select set_config('request.jwt.claim.sub',(select user_id::text from listing_test_users where code='II'),true);
do $$ declare item app.items; first_item app.items; begin
 item:=app.set_delivery_listing_progress((select id from listing_test_fixtures where kind='photo'),null);
 if item.photo_uploaded_at is null or item.product_registered_at is not null or item.status<>'作業中' then raise exception 'Photo upload completed product registration';end if;
 first_item:=item;
 item:=app.set_delivery_listing_progress(item.id,null);
 if item.photo_uploaded_at is distinct from first_item.photo_uploaded_at then raise exception 'Photo upload overwrote timestamp';end if;
 item:=app.set_delivery_progress(item.id,'listing',true);
 if item.photo_uploaded_at is null or item.product_registered_at is null then raise exception 'Combined check failed';end if;
 first_item:=item;
 item:=app.set_delivery_progress(item.id,'listing',true);
 if item.product_registered_at is distinct from first_item.product_registered_at or item.photo_uploaded_at is distinct from first_item.photo_uploaded_at then raise exception 'Repeated check overwrote progress';end if;
 item:=app.set_delivery_progress(item.id,'listing',false);
 if item.photo_uploaded_at is not null or item.product_registered_at is not null then raise exception 'Combined uncheck failed';end if;
 item:=app.set_delivery_progress(item.id,'inspection_cleaning',true);
 if item.inspected_at is null or item.cleaned_at is null then raise exception 'Inspection failed';end if;
 begin
   perform app.set_delivery_progress(item.id,'arrived',true);
   raise exception 'Legacy arrival accepted' using errcode='P9002';
 exception when sqlstate '22023' then null;end;
 begin
   perform app.set_delivery_listing_progress((select id from listing_test_fixtures where kind='other'),null);
   raise exception 'Another owner accepted' using errcode='P9002';
 exception when sqlstate '42501' then null;end;
 begin
   perform app.set_delivery_listing_progress((select id from listing_test_fixtures where kind='no_photo'),null);
   raise exception 'Photo event without photo accepted' using errcode='P9002';
 exception when sqlstate '22023' then null;end;
end $$;
select set_config('request.jwt.claim.sub',(select user_id::text from listing_test_users where code='AA'),true);
do $$ declare old_item app.items; item app.items; begin
 select * into old_item from app.items where id=(select id from listing_test_fixtures where kind='working_return');
 item:=app.set_delivery_progress(old_item.id,'listing',true);
 if item.product_registered_at is null or item.photo_uploaded_at is distinct from old_item.photo_uploaded_at then raise exception 'Working return exemption changed';end if;
 item:=app.set_delivery_progress(old_item.id,'listing',false);
 if item.product_registered_at is not null or item.photo_uploaded_at is distinct from old_item.photo_uploaded_at then raise exception 'Working return uncheck changed';end if;
 item:=app.set_delivery_progress((select id from listing_test_fixtures where kind='photo'),'packed',true,current_date-1);
 if item.packed_on<>current_date-1 or item.status<>'作業中' then raise exception 'Packing status failed';end if;
 item:=app.set_delivery_progress(item.id,'shipped',true,current_date);
 if item.shipped_on<>current_date or item.status<>'出品中' then raise exception 'Shipping status failed';end if;
 update app.items set status='販売済',sold_on=sold_on,returned_on=returned_on where lot_seq=2102 and not is_accessory;
 if (select status from app.items where lot_seq=2102 and not is_accessory)<>'販売済' then raise exception '2102 manual sale override failed';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ begin
 begin
   perform app.set_delivery_listing_progress((select id from listing_test_fixtures where kind='photo'),null);
   raise exception 'Anonymous listing accepted' using errcode='P9002';
 exception when sqlstate '42501' then null;end;
end $$;
reset role;
do $$ begin
 if exists(select 1 from app.item_photos p full join preserved_listing_photos b using(id) where to_jsonb(p) is distinct from b.value) then raise exception 'Photo metadata changed';end if;
 if exists(select 1 from app.photo_reviews r full join preserved_listing_reviews b using(item_id) where to_jsonb(r) is distinct from b.value) then raise exception 'Photo approval changed';end if;
end $$;
select 'Four-state enum, integrated listing/photo-only distinction, timestamps, working return exemption, ownership, anon denial, packing/shipping and sale override passed' as result;
rollback;
