begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code=case when n=990301 then 'DD' else 'HH' end),current_date,'catalog fixture',1000,'ヤフオク','123456' from generate_series(990301,990302) n;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p jsonb;q jsonb;target uuid;n integer;begin
 p:=app.read_delivery_catalog_page('{"queryField":"serial","query":"990302"}',50,'{}');
 if (p->>'total')::integer<>1 or jsonb_array_length(p->'rows')<>1 then raise exception 'Another deliverer not visible in catalog';end if;
 if not ((p->'rows'->0) ? 'deliverer_name') or exists(select 1 from jsonb_each(p->'rows'->0) e where e.key in ('cost_amount','sold_price','payout_amount','description','memo','malfunction_comment') and e.value<>'null'::jsonb) then raise exception 'Catalog card fields or cost visibility wrong';end if;
 target:=(p->'rows'->0->>'id')::uuid;
 q:=app.read_delivery_catalog_page('{"queryField":"serial","query":"990302"}',50,(p->'fingerprints')||jsonb_build_object('__revision',p->>'revision'));
 if not (q->>'unchanged')::boolean or octet_length(q::text)>250 then raise exception 'Catalog repeatedly transfers unchanged inventory';end if;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990302"}',50,'{}');
 if (q->>'total')::integer<>0 then raise exception 'Default assignment restriction changed';end if;
 if exists(select 1 from app.items where id=target) then raise exception 'Catalog widened base item RLS';end if;
 update app.items set title='forbidden catalog update' where id=target;get diagnostics n=row_count;
 if n<>0 then raise exception 'Another deliverer update allowed';end if;
 begin perform app.set_inventory_workflow(target,'商品登録前');raise exception 'Catalog bypassed workflow authorization';exception when insufficient_privilege then null;end;
 begin perform app.read_inventory_page('management','{}',50,'{}');raise exception 'Catalog granted management access';exception when insufficient_privilege then null;end;
 if has_table_privilege('authenticated','app.v_delivery_catalog','SELECT') or has_function_privilege('authenticated','app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)','EXECUTE') or has_function_privilege('anon','app.read_delivery_catalog_page(jsonb,integer,jsonb)','EXECUTE') then raise exception 'Private catalog internals exposed';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$declare p jsonb;begin
 p:=app.read_delivery_catalog_page('{"queryField":"serial","query":"990301"}',50,'{}');if (p->>'total')::integer<>1 then raise exception 'Second deliverer cannot use catalog';end if;
end $$;
reset role;
update app.staff set is_active=false where code='DD';
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin begin perform app.read_delivery_catalog_page('{}',50,'{}');raise exception 'Inactive staff can read catalog';exception when insufficient_privilege then null;end;end $$;
set local request.jwt.claim.sub='99999999-9999-9999-9999-999999999999';
do $$begin begin perform app.read_delivery_catalog_page('{}',50,'{}');raise exception 'Unlinked user can read catalog';exception when insufficient_privilege then null;end;end $$;
rollback;
