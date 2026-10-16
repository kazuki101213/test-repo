begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.products(asin,model_no,maker) values('BSYNC00001','sync fixture','SONY');
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,product_id,sold_on,sold_price,payout_amount,description)
select 991000+n,(select id from app.staff where code='AA'),(select id from app.staff where code=case when n=1 then 'DD' else 'HH' end),current_date-10,'resource sync fixture',1000,'ヤフオク',case when n=5 then 'メルカリ'::app.sales_channel else 'FBA'::app.sales_channel end,'123456',(select id from app.products where asin='BSYNC00001'),current_date-5+n,100*n+1,90*n,repeat('long detail',600) from generate_series(1,5) n;
insert into app.spare_accessories(title,owner_staff_id,owner_name,manufacturer)
select 'resource sync spare '||n,(select id from app.staff where code='DD'),'久保田ゆかり','SONY' from generate_series(1,1002) n;
create temporary table resource_probe as select app.read_resource_snapshot('spares') p;
create temporary table detail_probe as select app.read_inventory_page('delivery','{"queryField":"serial","query":"991001","status":"all"}',50,'{}') p;
do $$declare p jsonb;q jsonb;r text;begin
 select resource_probe.p into p from resource_probe;
 if (select count(*) from jsonb_array_elements(p->'rows') d where d->>'title' like 'resource sync spare %')<>1002 then raise exception 'Snapshot lost rows beyond 1000';end if;
 q:=app.read_resource_snapshot('spares','{}',(p->'fingerprints')||jsonb_build_object('__revision',p->>'revision'));
 if not (q->>'unchanged')::boolean or octet_length(q::text)>250 then raise exception 'Unchanged snapshot resends payload';end if;
 foreach r in array array['shipping','actions','malfunctions','photo_reviews','listing_tasks','invoice_tasks'] loop
  p:=app.read_resource_snapshot(r);
  if jsonb_array_length(p->'rows')<>jsonb_array_length(p->'ids') then raise exception 'Initial snapshot incomplete: %',r;end if;
  q:=app.read_resource_snapshot(r,'{}',(p->'fingerprints')||jsonb_build_object('__revision',p->>'revision'));
  if not(q->>'unchanged')::boolean then raise exception 'Unchanged detection failed: %',r;end if;
 end loop;
 p:=app.product_sale_summaries(array[(select id from app.products where asin='BSYNC00001')]);
 if (p->0->>'history_count')::int<>5 or (p->0->>'amazon_count')::int<>3 or (p->0->>'amazon_average')::int<>301 then raise exception 'Latest-three Amazon average differs: %',p;end if;
 select detail_probe.p into p from detail_probe;
 if jsonb_array_length(p->'rows')<>1 or not(p->'rows'->0->>'summary_only')::boolean or nullif(p->'rows'->0->>'description','') is not null or p->'rows'->0->>'detail_revision' is null then raise exception 'Detail text leaked into list';end if;
 if not exists(select 1 from app.v_delivery_tasks where lot_seq=991001 and length(description)>6000) then raise exception 'Full detail text lost';end if;
 if has_function_privilege('anon','app.read_resource_snapshot(text,jsonb,jsonb)','EXECUTE') or has_function_privilege('anon','app.product_sale_summaries(uuid[])','EXECUTE') then raise exception 'Anonymous RPC access';end if;
 if exists(select 1 from pg_proc where oid in('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure,'app.product_sale_summaries(uuid[])'::regprocedure) and prosecdef) then raise exception 'RPC bypasses RLS';end if;
end $$;
update app.spare_accessories set manufacturer='Panasonic' where title='resource sync spare 1';
delete from app.spare_accessories where title='resource sync spare 2';
update app.items set description='updated detail' where lot_seq=991001;
do $$declare q jsonb;p jsonb;begin
 q:=app.read_resource_snapshot('spares','{}',(select resource_probe.p->'fingerprints' from resource_probe));
 if jsonb_array_length(q->'rows')<>1 or q->'rows'->0->>'manufacturer'<>'Panasonic' or jsonb_array_length(q->'ids')<>(select jsonb_array_length(resource_probe.p->'ids')-1 from resource_probe) then raise exception 'Change/deletion diff incorrect';end if;
 select detail_probe.p into p from detail_probe;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"991001","status":"all"}',50,(p->'fingerprints')||jsonb_build_object('__revision',p->>'revision'));
 if jsonb_array_length(q->'rows')<>1 or q->'rows'->0->>'detail_revision'=p->'rows'->0->>'detail_revision' then raise exception 'Detail text revision not propagated';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p jsonb;r text;begin
 foreach r in array array['actions','photo_reviews','listing_tasks','invoice_tasks'] loop
  begin perform app.read_resource_snapshot(r);raise exception 'Deliverer accessed admin resource %',r;exception when insufficient_privilege then null;end;
 end loop;
 p:=app.read_resource_snapshot('spares');
 if exists(select 1 from jsonb_array_elements(p->'rows') d where d->>'owner_staff_id'<>(select id::text from app.staff where code='DD')) then raise exception 'Other owner spare leaked';end if;
 p:=app.read_resource_snapshot('spares',jsonb_build_object('owner',(select id from app.staff where code='HH')));
 if jsonb_array_length(p->'rows')<>0 then raise exception 'Owner filter bypassed RLS';end if;
 p:=app.read_resource_snapshot('malfunctions');if jsonb_array_length(p->'rows')<>0 then raise exception 'Deliverer accessed management malfunctions';end if;
end $$;
rollback;
