begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code=case when n=990201 then 'DD' else 'HH' end),current_date,'paged inventory fixture',1000,'ヤフオク','メルカリ','123456' from generate_series(990201,990202) n;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
select 990201,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'paged accessory fixture',100,'ヤフオク',true;
create temporary table page_probe as select app.read_inventory_page('delivery','{"queryField":"serial","query":"９９０２０１","status":"検品中"}',1,'{}') p;
do $$declare p jsonb;q jsonb;begin
 select page_probe.p into p from page_probe;
 if (p->>'total')::integer<>1 or jsonb_array_length(p->'rows')<>2 then raise exception 'Serial page split a body/accessory group';end if;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201","status":"検品中"}',1,p->'fingerprints');
 if jsonb_array_length(q->'rows')<>0 or q->'ids'<>p->'ids' then raise exception 'Unchanged page repeated full rows';end if;
 if not exists(select 1 from jsonb_array_elements(p->'rows') d where nullif(d->>'deliverer_name','') is not null) then raise exception 'Assignee missing from paged response';end if;
 if has_function_privilege('anon','app.read_inventory_page(text,jsonb,integer,jsonb)','EXECUTE') then raise exception 'Anonymous inventory reader exposed';end if;
 if exists(select 1 from pg_proc where oid='app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure and prosecdef) then raise exception 'Page reader bypasses RLS';end if;
end $$;
update app.items set memo='changed row only' where lot_seq=990201 and not is_accessory;
do $$declare q jsonb;begin
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201","status":"検品中"}',1,(select p->'fingerprints' from page_probe));
 if jsonb_array_length(q->'rows')<>1 then raise exception 'Changed row diff not isolated';end if;
end $$;
select app.set_inventory_workflow((select id from app.items where lot_seq=990201 and not is_accessory),'商品登録前');
do $$declare q jsonb;begin
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201","status":"検品中"}',1,(select p->'fingerprints' from page_probe));
 if q->'ids'<>'[]'::jsonb or (q->>'total')::integer<>0 then raise exception 'Out-of-filter group retained';end if;
 q:=app.read_inventory_page('management','{"queryField":"serial","query":"990201"}',1,'{}');
 if (q->>'total')::integer<>1 then raise exception 'Management serial pagination failed: page=%, direct=%, sku=%, role=%', q, (select count(*) from app.v_inventory_display where lot_seq=990201),(select array_agg(sku) from app.items where lot_seq=990201), app.current_role();end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare q jsonb;begin
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990202"}',50,'{}');
 if q->'ids'<>'[]'::jsonb or (q->>'total')::integer<>0 then raise exception 'Another deliverer leaked through pagination';end if;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201"}',50,'{}');
 if jsonb_array_length(q->'rows')<>2 then raise exception 'Own complete group unavailable';end if;
end $$;
rollback;
