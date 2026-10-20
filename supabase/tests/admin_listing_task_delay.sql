begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,status)
 select 998430+n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Listing delay fixture',1000,'メルカリ',case (n-1)%4 when 0 then 'メルカリ' when 1 then 'ヤフオク' when 2 then '自己発送' else 'FBA' end::app.sales_channel,'fixture',now(),'商品登録前' from generate_series(1,8) n;
set local role postgres;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at,approved_at,approved_by)
 select id,'fixture_folder',1,now()-interval '8 days',now()-case when sales_channel='FBA' then interval '120 hours' else interval '24 hours' end+case when lot_seq<=998434 then interval '1 second' else interval '0 seconds' end,purchaser_id from app.items where lot_seq between 998431 and 998438;
set local role authenticated;
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('listing_tasks');
 if (select count(*) from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int between 998431 and 998438)<>4 then raise exception 'Listing reminder delay boundary failed';end if;
 if exists(select 1 from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int between 998431 and 998434) then raise exception 'Reminder appeared before 24/120 hours';end if;
 if (select count(distinct r->>'sales_channel') from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int between 998435 and 998438)<>4 then raise exception 'Four channels not covered';end if;
end $$;
update app.items set status='出品中' where lot_seq=998435;
update app.items set sold_on=current_date where lot_seq=998436;
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('listing_tasks');
 if exists(select 1 from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int in(998435,998436)) then raise exception 'Listed or sold product remains reminder';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 begin perform app.read_resource_snapshot('listing_tasks');raise exception 'Deliverer accessed admin tasks';exception when insufficient_privilege then null;end;
end $$;
rollback;
