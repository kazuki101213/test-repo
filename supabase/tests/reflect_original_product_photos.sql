begin;
insert into app.items(lot_seq,sku,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no,inspected_at,status)
 select 998561,'998561'||suffix||'-AADD-20261020-1000',(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Photo reflection fixture',1000,'メルカリ','fixture',now(),'商品登録前'
 from unnest(array['','a','b']) suffix;
insert into app.item_photos(id,item_id,storage_path,uploaded_by,drive_file_id,photo_kind)
 select ('99856100-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,i.id,'fixture/'||n||'.jpg',i.deliverer_id,case when n=3 then null else 'source-file-'||n end,case when n=2 then 'packing' else 'product' end
 from app.items i cross join generate_series(1,3) n where i.lot_seq=998561 and split_part(i.sku,'-',1)='998561';
do $$declare target uuid; source uuid:='99856100-0000-0000-0000-000000000001'; actor uuid; photo uuid; again uuid;begin
 select id into target from app.items where lot_seq=998561 and split_part(sku,'-',1)='998561a';
 select id into actor from app.staff where code='DD';
 photo:=app.record_reflected_product_photo(target,source,actor);
 again:=app.record_reflected_product_photo(target,source,actor);
 if photo is distinct from again or (select count(*) from app.item_photos where item_id=target)<>1 then raise exception 'Duplicate reflection';end if;
 if (select drive_file_id from app.item_photos where id=photo) is not null then raise exception 'Source Drive ID reused';end if;
 if (select storage_path from app.item_photos where id=photo) not like '998561a-%/reflected-%' then raise exception 'Copy does not belong to target';end if;
 if exists(select 1 from app.photo_reviews where item_id=target) then raise exception 'Reflection auto-submitted review';end if;
 begin perform app.record_reflected_product_photo(target,'99856100-0000-0000-0000-000000000002',actor);raise exception 'Packing photo imported';exception when invalid_parameter_value then null;end;
 begin perform app.record_reflected_product_photo(target,'99856100-0000-0000-0000-000000000003',actor);raise exception 'Unsaved photo imported';exception when invalid_parameter_value then null;end;
 begin perform app.record_reflected_product_photo(target,source,gen_random_uuid());raise exception 'Unknown actor allowed';exception when insufficient_privilege then null;end;
 begin perform app.record_reflected_product_photo((select id from app.items where lot_seq=998561 and split_part(sku,'-',1)='998561b'),source,actor);raise exception 'Non-a target allowed';exception when invalid_parameter_value then null;end;
 delete from app.item_photos where id=photo;
 if not exists(select 1 from app.item_photos where id=source and drive_file_id='source-file-1') then raise exception 'Source photo lost';end if;
 if has_function_privilege('authenticated','app.record_reflected_product_photo(uuid,uuid,uuid)','execute') or has_function_privilege('anon','app.record_reflected_product_photo(uuid,uuid,uuid)','execute') then raise exception 'Client can forge reflection';end if;
 if not has_function_privilege('service_role','app.record_reflected_product_photo(uuid,uuid,uuid)','execute') then raise exception 'Edge role cannot register';end if;
end $$;
rollback;
