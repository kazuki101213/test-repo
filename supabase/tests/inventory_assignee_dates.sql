begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
select n,(select id from app.staff where code='AA'),
 (select id from app.staff where code=case n when 990741 then 'DD' when 990742 then 'HH' else 'II' end),
 case when n=990741 then date '2099-08-01' else date '2099-08-20' end,
 'multi assignee UI fixture',1000,'ヤフオク','メルカリ'
from generate_series(990741,990743) n;
do $$ declare f jsonb; p jsonb; scope text; begin
 f:=jsonb_build_object('queryField','model','query','multi assignee UI fixture','from','2099-08-01','to','2099-08-31',
  'delivererIds',jsonb_build_array((select id::text from app.staff where code='DD'),(select id::text from app.staff where code='HH')));
 foreach scope in array array['management','delivery','delivery-all'] loop
  if scope='delivery-all' then p:=app.read_delivery_catalog_page(f,50,'{}');
  else p:=app.read_inventory_page(scope,f,50,'{}'); end if;
  if (p->>'total')::integer<>2 then raise exception 'Assignee OR filtering failed for %: %',scope,p;end if;
  if scope='delivery-all' then p:=app.read_delivery_catalog_page(f||'{"from":"2099-08-20"}',50,'{}');
  else p:=app.read_inventory_page(scope,f||'{"from":"2099-08-20"}',50,'{}');end if;
  if (p->>'total')::integer<>1 then raise exception 'Dates did not combine with assignees for %',scope;end if;
 end loop;
 p:=app.read_inventory_page('management',f||'{"delivererIds":[]}',50,'{}');
 if (p->>'total')::integer<>3 then raise exception 'Empty assignee list must clear the filter';end if;
 begin perform app.inventory_page_matches('{"deliverer_id":"x"}','{"delivererIds":"x"}','management');
  raise exception 'Invalid assignee shape accepted';exception when sqlstate '22023' then null;end;
 if has_function_privilege('anon','app.inventory_page_matches(jsonb,jsonb,text)','EXECUTE') then raise exception 'Anonymous filter access';end if;
 if exists(select 1 from pg_proc where oid='app.inventory_page_matches(jsonb,jsonb,text)'::regprocedure and prosecdef) then raise exception 'Filtering bypasses RLS';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p jsonb;f jsonb;begin
 f:=jsonb_build_object('queryField','model','query','multi assignee UI fixture','delivererIds',
  jsonb_build_array((select id::text from app.staff where code='DD'),(select id::text from app.staff where code='HH')));
 p:=app.read_inventory_page('delivery',f,50,'{}');
 if (p->>'total')::integer<>1 then raise exception 'Multi-select widened deliverer RLS';end if;
 if exists(select 1 from jsonb_array_elements(p->'rows') r where r->>'deliverer_id'<>(select id::text from app.staff where code='DD')) then raise exception 'Other assignee exposed';end if;
end $$;
rollback;
