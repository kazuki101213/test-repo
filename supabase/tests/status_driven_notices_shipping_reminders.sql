begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at,status)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date-10,'status reminder fixture',1000,'メルカリ',case n when 998441 then 'メルカリ'::app.sales_channel when 998442 then 'ヤフオク'::app.sales_channel when 998443 then '自己発送'::app.sales_channel else 'FBA'::app.sales_channel end,'fixture',now(),'商品登録前' from generate_series(998441,998444) n;
insert into app.photo_reviews(item_id,drive_folder_id,exported_photo_count,submitted_at,approved_at,approved_by)
 select id,'fixture',1,now()-interval '8 days',now()-interval '7 days',purchaser_id from app.items where lot_seq between 998441 and 998444;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 if (select count(*) from app.v_delivery_notice_tasks where lot_seq between 998441 and 998444 and kind='photo_approved' and expires_at is null)<>4 then raise exception 'Unlisted requests expire or omit a channel';end if;
end $$;
set local role postgres;
update app.items set status='出品中' where lot_seq between 998441 and 998444;
set local role authenticated;
do $$begin
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq between 998441 and 998444 and kind='photo_approved') then raise exception 'Listed request remains';end if;
end $$;
set local role postgres;
update app.items set status='取引中' where lot_seq between 998441 and 998444;
update app.delivery_shipping_tasks t set created_at=now()-case when i.lot_seq=998443 then interval '7 days' else interval '24 hours' end+case when i.lot_seq=998442 then interval '1 second' else interval '0 seconds' end from app.items i where t.item_id=i.id and i.lot_seq between 998441 and 998444;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('admin_shipping_tasks');
 if (select count(*) from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int between 998441 and 998444)<>2 then raise exception 'Shipping 24-hour boundary or FBA exclusion incorrect';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=998443 and kind='shipping' and expires_at is null) then raise exception 'Seven-day unshipped request expired';end if;
end $$;
set local role postgres;
update app.items set sold_on=current_date where lot_seq=998443;
set local role authenticated;
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('admin_shipping_tasks');
 if not exists(select 1 from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int=998443) then raise exception 'Sales import hid unshipped reminder';end if;
 if not exists(select 1 from app.v_delivery_notice_tasks where lot_seq=998443 and kind='shipping') then raise exception 'Sales import hid delivery shipping request';end if;
end $$;
set local role postgres;
update app.items set shipped_on=current_date where lot_seq in(998441,998443);
set local role authenticated;
do $$declare payload jsonb;begin
 payload:=app.read_resource_snapshot('admin_shipping_tasks');
 if exists(select 1 from jsonb_array_elements(payload->'rows') r where (r->>'lot_seq')::int in(998441,998443)) then raise exception 'Shipped admin reminder remains';end if;
 if exists(select 1 from app.v_delivery_notice_tasks where lot_seq in(998441,998443) and kind='shipping') then raise exception 'Shipped delivery request remains';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
 begin perform app.read_resource_snapshot('admin_shipping_tasks');raise exception 'Non-admin accessed admin shipping';exception when insufficient_privilege then null;end;
end $$;
rollback;
