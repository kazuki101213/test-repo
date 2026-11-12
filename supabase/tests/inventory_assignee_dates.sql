begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id)
select n,(select id from app.staff where code='AA'),
 (select id from app.staff where code=case n when 990741 then 'DD' when 990742 then 'HH' else 'II' end),
 case when n=990741 then date '2099-08-01' else date '2099-08-20' end,
 'multi assignee UI fixture',1000,'ヤフオク','メルカリ','fixture-body-'||n
from generate_series(990741,990743) n;
insert into app.items(lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,marketplace_item_id)
select lot_seq,id,true,purchaser_id,deliverer_id,purchased_at,'inventory accessory fixture remote',100,'ヤフオク','fixture-accessory-'||lot_seq
from app.items where lot_seq in (990741,990742) and not is_accessory;
insert into app.spare_accessories(owner_staff_id,title,marketplace,marketplace_item_id,usage_note,used_for_item_id)
select deliverer_id,'inventory accessory fixture remote','ヤフオク','fixture-accessory-990741','990700',id
from app.items where lot_seq=990741 and not is_accessory;
insert into app.spare_accessories(owner_staff_id,title,marketplace,marketplace_item_id,usage_note,used_for_item_id)
select deliverer_id,'inventory accessory fixture remote','ヤフオク','fixture-accessory-990741','990701',id
from app.items where lot_seq=990742 and not is_accessory;
insert into app.spare_accessories(owner_staff_id,title,marketplace,marketplace_item_id,usage_note,used_for_item_id)
select deliverer_id,'inventory accessory fixture remote','ヤフオク','fixture-accessory-990742','990702',id
from app.items where lot_seq=990742 and is_accessory;
reset role;
insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,state,registered_item_id)
select 'ヤフオク',marketplace_item_id,'https://auctions.yahoo.co.jp/jp/auction/fixture-body-990741','ヤフオク1',title,'registered',id
from app.items where lot_seq=990741 and not is_accessory;
insert into app.seller_listings(item_id,channel,account_id,external_id,url)
select id,'メルカリ','mercari-1','m990741','https://jp.mercari.com/item/m990741'
from app.items where lot_seq=990741 and not is_accessory;
set local role authenticated;
do $$ declare f jsonb; p jsonb; scope text; begin
 f:=jsonb_build_object('queryField','model','query','multi assignee UI fixture','from','2099-08-01','to','2099-08-31',
  'delivererIds',jsonb_build_array((select id::text from app.staff where code='DD'),(select id::text from app.staff where code='HH')));
 foreach scope in array array['management','delivery','delivery-all'] loop
  if scope='delivery-all' then p:=app.read_delivery_catalog_page(f,50,'{}');
  else p:=app.read_inventory_page(scope,f,50,'{}'); end if;
  if (p->>'total')::integer<>2 then raise exception 'Assignee OR filtering failed for %: %',scope,p;end if;
  if not exists(select 1 from jsonb_array_elements(p->'rows') r where r->>'marketplace_item_id'='fixture-body-990741'
      and r->>'purchase_account_label'='ヤフオク1' and r->>'sales_account_label'='メルカリ1')
  then raise exception 'Marketplace account labels missing for %: %',scope,p;end if;
  if scope='delivery-all' then p:=app.read_delivery_catalog_page(f||'{"from":"2099-08-20"}',50,'{}');
  else p:=app.read_inventory_page(scope,f||'{"from":"2099-08-20"}',50,'{}');end if;
  if (p->>'total')::integer<>1 then raise exception 'Dates did not combine with assignees for %',scope;end if;
 end loop;
 p:=app.read_inventory_page('management',f||'{"delivererIds":[]}',50,'{}');
 if (p->>'total')::integer<>3 then raise exception 'Empty assignee list must clear the filter';end if;
 p:=app.read_inventory_page('management','{"queryField":"accessory_name","query":"accessory fixture remote"}',50,'{}');
 if (p->>'total')::integer<>2 or jsonb_array_length(p->'rows')<>2
    or exists(select 1 from jsonb_array_elements(p->'rows') r where not (r->>'is_accessory')::boolean)
 then raise exception 'Accessory name should find matching accessories in management: %',p;end if;
 p:=app.read_inventory_page('delivery','{"queryField":"marketplace_item_id","query":"fixture-accessory-990741"}',50,'{}');
 if (p->>'total')::integer<>1 or jsonb_array_length(p->'rows')<>2
    or not exists(select 1 from jsonb_array_elements(p->'rows') r where r->>'marketplace_item_id'='fixture-accessory-990741' and r->>'accessory_usage_note'='990700')
 then raise exception 'Accessory ID should find its own delivery group: %',p;end if;
 begin perform app.inventory_page_matches('{"deliverer_id":"x"}','{"delivererIds":"x"}','management');
  raise exception 'Invalid assignee shape accepted';exception when sqlstate '22023' then null;end;
 if has_function_privilege('anon','app.inventory_page_matches(jsonb,jsonb,text)','EXECUTE') then raise exception 'Anonymous filter access';end if;
 if exists(select 1 from pg_proc where oid='app.inventory_page_matches(jsonb,jsonb,text)'::regprocedure and prosecdef) then raise exception 'Filtering bypasses RLS';end if;
 if has_function_privilege('anon','app.inventory_marketplace_accounts(uuid)','EXECUTE') then raise exception 'Anonymous account label access';end if;
 if not app.inventory_page_matches('{"marketplace":"動作品Amazon返品","title":"iBasso Nunchaku"}','{"queryField":"model","query":"Nunchaku"}','management')
   or app.inventory_page_matches('{"marketplace":"動作品Amazon返品","title":"X001EMTLVR"}','{"queryField":"model","query":"X001EMTLVR"}','delivery')
 then raise exception 'Saved return model search or FNSKU exclusion failed';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p jsonb;f jsonb;begin
 f:=jsonb_build_object('queryField','model','query','multi assignee UI fixture','delivererIds',
  jsonb_build_array((select id::text from app.staff where code='DD'),(select id::text from app.staff where code='HH')));
 p:=app.read_inventory_page('delivery',f,50,'{}');
 if (p->>'total')::integer<>1 then raise exception 'Multi-select widened deliverer RLS';end if;
 if exists(select 1 from jsonb_array_elements(p->'rows') r where r->>'deliverer_id'<>(select id::text from app.staff where code='DD')) then raise exception 'Other assignee exposed';end if;
 f:='{"queryField":"accessory_name","query":"inventory accessory fixture remote"}';
 p:=app.read_inventory_page('delivery',f,50,'{}');
 if (p->>'total')::integer<>1 or jsonb_array_length(p->'rows')<>2 then raise exception 'Assigned accessory search lost its group or widened scope: %',p;end if;
 if not exists(select 1 from jsonb_array_elements(p->'rows') r where r->>'marketplace_item_id'='fixture-accessory-990741' and r->>'accessory_usage_note'='990700')
 then raise exception 'Assigned deliverer lost the matching use note: %',p;end if;
 p:=app.read_delivery_catalog_page(f,50,'{}');
 if (p->>'total')::integer<>2 or jsonb_array_length(p->'rows')<>4 then raise exception 'Catalog accessory search lost groups: %',p;end if;
 if not exists(select 1 from jsonb_array_elements(p->'rows') r where r->>'marketplace_item_id'='fixture-accessory-990742' and r->>'accessory_usage_note'='990702')
 then raise exception 'Catalog lost the direct accessory use note or matched a different product ID: %',p;end if;
end $$;
rollback;
