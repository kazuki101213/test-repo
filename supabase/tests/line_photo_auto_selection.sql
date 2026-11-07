-- Isolated CI database only. No external AI, LINE or marketplace requests.
begin;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.delivery_line_settings set enabled=false;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status)
 select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'photo role fixture',1000,'メルカリ','メルカリ','受取前' from generate_series(998781,998785)n;
insert into app.item_photos(item_id,storage_path,photo_kind)
 select id,'auto-photo/'||lot_seq||'/'||n||'.jpg','product' from app.items cross join generate_series(1,6)n where lot_seq in(998781,998782,998783,998784);
insert into app.item_photos(item_id,storage_path,photo_kind) select id,'packing.jpg','packing' from app.items where lot_seq=998781;
insert into app.seller_listings(item_id,channel,account_id,external_id,url,trade_key)
 select id,'メルカリ','mercari-1','m'||lot_seq,'https://jp.mercari.com/item/m'||lot_seq,'m'||lot_seq||':current' from app.items where lot_seq=998785;
do $$declare i uuid;c jsonb;front uuid;model uuid;other uuid;result boolean;begin
 select id into i from app.items where lot_seq=998781;
 if not exists(select 1 from app.line_photo_selections where item_id=i) then raise exception 'Upload did not enqueue automatic selection';end if;
 update app.line_photo_selections set next_attempt_at=now() where item_id=i;
 c:=app.claim_line_photo_selection(i);
 if jsonb_array_length(c->'photos')<>6 then raise exception 'Packing entered product classification';end if;
 if app.claim_line_photo_selection(i) is not null then raise exception 'Concurrent duplicate claim';end if;
 front:=(c->'photos'->0->>'id')::uuid;model:=(c->'photos'->3->>'id')::uuid;
 result:=app.finish_line_photo_selection(i,(c->>'lease')::uuid,jsonb_build_object('source','app','overview',jsonb_build_object('id',front),'model',jsonb_build_object('id',model)));
 if not result or not exists(select 1 from app.delivery_line_preferences where item_id=i and overview_photo_id=front and model_photo_id=model) then raise exception 'Auto roles not saved';end if;
 if app.finish_line_photo_selection(i,(c->>'lease')::uuid,'{}') then raise exception 'Consumed lease reused';end if;
 -- Saved roles are reused; a second patrol does not call AI again.
 perform app.enqueue_line_photo_selection(i);
 if app.claim_line_photo_selection(i) is not null then raise exception 'Saved roles reclassified';end if;
 -- Another product's photo must never be accepted.
 select id into i from app.items where lot_seq=998782;
 update app.line_photo_selections set next_attempt_at=now() where item_id=i;c:=app.claim_line_photo_selection(i);
 result:=app.finish_line_photo_selection(i,(c->>'lease')::uuid,jsonb_build_object('overview',jsonb_build_object('id',front),'model',jsonb_build_object('id',model)));
 if result or exists(select 1 from app.delivery_line_preferences where item_id=i) then raise exception 'Other item photos accepted';end if;
 -- Manual settings saved while AI is running win; shipping must survive.
 select id into i from app.items where lot_seq=998783;update app.line_photo_selections set next_attempt_at=now() where item_id=i;c:=app.claim_line_photo_selection(i);
 front:=(c->'photos'->0->>'id')::uuid;model:=(c->'photos'->3->>'id')::uuid;other:=(c->'photos'->2->>'id')::uuid;
 insert into app.delivery_line_preferences(item_id,overview_photo_id,model_photo_id,shipping) values(i,other,other,'{"size":"100","dropoff":"セブンイレブン"}');
 perform app.finish_line_photo_selection(i,(c->>'lease')::uuid,jsonb_build_object('overview',jsonb_build_object('id',front),'model',jsonb_build_object('id',model)));
 if not exists(select 1 from app.delivery_line_preferences where item_id=i and overview_photo_id=other and model_photo_id=other and shipping->>'size'='100') then raise exception 'Manual settings overwritten';end if;
 -- An upload during classification invalidates its snapshot, then retries.
 select id into i from app.items where lot_seq=998784;update app.line_photo_selections set next_attempt_at=now() where item_id=i;c:=app.claim_line_photo_selection(i);
 insert into app.item_photos(item_id,storage_path,photo_kind) values(i,'later.jpg','product');
 if app.finish_line_photo_selection(i,(c->>'lease')::uuid,jsonb_build_object('overview',jsonb_build_object('id',c->'photos'->0->>'id'),'model',null)) then raise exception 'Stale partial upload committed';end if;
 -- Listing fallback context is current and exact; no own app photos means empty.
 select id into i from app.items where lot_seq=998785;update app.line_photo_selections set next_attempt_at=now() where item_id=i;c:=app.claim_line_photo_selection(i);
 if jsonb_array_length(c->'photos')<>0 or c->'listing'->>'externalId'<>'m998785' then raise exception 'Listing fallback not bound to item';end if;
 perform app.finish_line_photo_selection(i,(c->>'lease')::uuid,'{}','temporary fixture failure');
 if not exists(select 1 from app.line_photo_selections where item_id=i and state='failed' and next_attempt_at>now() and last_error is not null) then raise exception 'Retry not recorded';end if;
 if has_function_privilege('authenticated','app.claim_line_photo_selection(uuid)','execute') or has_table_privilege('authenticated','app.line_photo_selections','insert') then raise exception 'Private role selection exposed';end if;
end $$;
rollback;
