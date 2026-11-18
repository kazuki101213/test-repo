begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code=case when n=990201 then 'DD' else 'HH' end),current_date,'paged inventory fixture',1000,'ヤフオク','メルカリ','123456' from generate_series(990201,990202) n;
-- An explicit suffix tests separate management groups without relying on the
-- old workflow-sync bug to rewrite the accessory's purchase SKU into suffix a.
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
select '990201a-AADD-'||to_char(current_date,'YYYYMMDD')||'-10',990201,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'paged accessory fixture',100,'ヤフオク',true;
update app.items set purchased_at=current_date-30 where lot_seq=990202;
do $$
declare
 filters constant jsonb := '{"queryField":"tracking_no","query":"123456","status":"all"}';
 by_date jsonb;
 by_serial jsonb;
 expanded jsonb;
begin
 by_date := app.read_inventory_page('delivery', filters, 1, '{}');
 by_serial := app.read_inventory_page('delivery', filters || '{"sort":"serial"}', 1, '{}');
 expanded := app.read_inventory_page('delivery', filters || '{"sort":"serial"}', 2, '{}');
 if by_date->'rows'->0->>'lot_seq' is distinct from '990201'
    or by_serial->'rows'->0->>'lot_seq' is distinct from '990202'
    or jsonb_array_length(by_serial->'rows') <> 1
    or expanded->'rows'->0->>'lot_seq' is distinct from '990202'
    or expanded->'rows'->1->>'lot_seq' is distinct from '990201'
    or jsonb_array_length(expanded->'rows') <> 3 then
   raise exception 'All-status serial sorting did not order groups before paging';
 end if;
end $$;
create temporary table page_probe as select app.read_inventory_page('delivery','{"queryField":"serial","query":"９９０２０１","status":"検品中"}',1,'{}') p;
do $$
declare
  buyer uuid := (select id from app.staff where code='AA');
  other_buyer uuid := (select id from app.staff where code='DD');
  other_deliverer uuid := (select id from app.staff where code='HH');
  filters jsonb := jsonb_build_object('queryField','serial','query','990201');
  page jsonb;
begin
  page := app.read_inventory_page('management',filters || jsonb_build_object('purchaserIds',jsonb_build_array(buyer,other_buyer)),50,'{}');
  if (page->>'total')::int <> 2 then raise exception 'Purchaser filter failed to match both management rows'; end if;
  page := app.read_inventory_page('management',filters || jsonb_build_object('purchaserIds',jsonb_build_array(buyer),'delivererIds',jsonb_build_array(other_deliverer)),50,'{}');
  if (page->>'total')::int <> 0 then raise exception 'Purchaser filter bypassed the deliverer filter'; end if;
  page := app.read_inventory_page('delivery',filters || jsonb_build_object('purchaserIds',jsonb_build_array(buyer)),1,'{}');
  if (page->>'total')::int <> 1 or jsonb_array_length(page->'rows') <> 2 then
    raise exception 'Purchaser filter failed to preserve a delivery group';
  end if;
  page := app.read_inventory_page('delivery',filters || jsonb_build_object('purchaserIds',jsonb_build_array(other_buyer)),1,'{}');
  if (page->>'total')::int <> 0 then raise exception 'Delivery matched a different purchaser'; end if;
end $$;
do $$declare p jsonb;q jsonb;begin
 select page_probe.p into p from page_probe;
 if (p->>'total')::integer<>1 or jsonb_array_length(p->'rows')<>2 then raise exception 'Serial page split a body/accessory group';end if;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201","status":"検品中"}',1,p->'fingerprints');
 if jsonb_array_length(q->'rows')<>0 or q->'ids'<>p->'ids' then raise exception 'Unchanged page repeated full rows';end if;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201","status":"検品中"}',1,(p->'fingerprints')||jsonb_build_object('__revision',p->>'revision'));
 if not (q->>'unchanged')::boolean or octet_length(q::text)>250 then raise exception 'Unchanged revision repeated its manifest';end if;
 if exists(select 1 from jsonb_array_elements(p->'rows') d where not d ? 'original_marketplace_item_id') then raise exception 'Origin ID missing from paged response';end if;
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
 if (q->>'total')::integer<>(select count(distinct app.product_serial(sku,lot_seq)) from app.v_inventory_display where lot_seq=990201) or jsonb_array_length(q->'rows')<>1 then raise exception 'Management suffix groups or page size changed';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare q jsonb;begin
 begin perform app.read_inventory_page('management','{}',50,'{}');raise exception 'Deliverer can use management reader';exception when insufficient_privilege then null;end;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990202"}',50,'{}');
 if q->'ids'<>'[]'::jsonb or (q->>'total')::integer<>0 then raise exception 'Another deliverer leaked through pagination';end if;
 q:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990201"}',50,'{}');
 if jsonb_array_length(q->'rows')<>2 then raise exception 'Own complete group unavailable';end if;
end $$;

-- A spare registered to a resale must stay with that explicit parent despite its unique suffix.
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace)
select '990203aa-AADD-20261001-100',990203,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),'2026-10-01','parent grouping fixture',1000,'ヤフオク';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace)
select '990203b-AAHH-20261001-100',990203,(select id from app.staff where code='AA'),(select id from app.staff where code='HH'),'2026-10-01','unrelated resale fixture',1000,'ヤフオク';
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory,parent_item_id)
select '990203aaaaa-AADD-20261002-10',990203,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),'2026-10-02','parent spare fixture',100,'ヤフオク',true,(select id from app.items where title='parent grouping fixture');
do $$declare p jsonb; q jsonb; key text;begin
 select lower(app.product_serial(sku,lot_seq)) into key from app.items where title='parent grouping fixture';
 p:=app.read_inventory_page('delivery',jsonb_build_object('queryField','sku','query',(select sku from app.items where title='parent grouping fixture')),1,'{}');
 if (p->>'total')::integer<>1 or jsonb_array_length(p->'rows')<>2 then raise exception 'Parent search omitted its uniquely numbered spare';end if;
 if exists(select 1 from jsonb_array_elements(p->'rows') d where d->>'inventory_group_serial'<>key) then raise exception 'Parent and spare have different rendering groups';end if;
 q:=app.read_inventory_page('delivery',jsonb_build_object('queryField','sku','query',(select sku from app.items where title='parent spare fixture')),1,'{}');
 if q->'ids'<>p->'ids' then raise exception 'Accessory search omitted its parent';end if;
 q:=app.read_inventory_page('delivery',jsonb_build_object('queryField','sku','query',(select sku from app.items where title='unrelated resale fixture')),1,'{}');
 if jsonb_array_length(q->'rows')<>1 then raise exception 'Different resale merged into explicit parent group';end if;
 q:=app.read_inventory_page('delivery',jsonb_build_object('queryField','sku','query',(select sku from app.items where title='parent grouping fixture')),1,(p->'fingerprints')||jsonb_build_object('__revision',p->>'revision'));
 if not (q->>'unchanged')::boolean then raise exception 'Explicit parent group broke unchanged revision';end if;
 q:=app.read_inventory_page('management',jsonb_build_object('queryField','sku','query',(select sku from app.items where title='parent spare fixture')),50,'{}');
 if not exists(select 1 from jsonb_array_elements(q->'rows') d where d->>'title'='parent spare fixture'
   and d->>'inventory_parent_serial'=key and d->>'inventory_parent_purchased_at'='2026-10-01'
   and d->>'inventory_parent_status' is not null) then raise exception 'Management accessory lacks authorized parent presentation context';end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$declare p jsonb;begin
 p:=app.read_inventory_page('delivery','{"queryField":"serial","query":"990203"}',50,'{}');
 if jsonb_array_length(p->'rows')<>2 or exists(select 1 from jsonb_array_elements(p->'rows') d where d->>'title'='unrelated resale fixture') then raise exception 'Parent grouping changed staff visibility';end if;
end $$;

set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
update app.items set sales_channel='FBA2', status='出品中'
where title in ('parent grouping fixture','unrelated resale fixture');
do $$declare p jsonb; accessory_group text;begin
 p:=app.read_inventory_page('management',
    '{"queryField":"serial","query":"990203","states":{"status":["出品中"],"sales_channel":["FBA2"]}}',50,'{}');
 if (p->>'total')::integer<>2 or jsonb_array_length(p->'rows')<>3 then
   raise exception 'Amazon listing total must group the spare and preserve the other listing';
 end if;
 select d->>'inventory_group_serial' into strict accessory_group from jsonb_array_elements(p->'rows') d
 where d->>'title'='parent spare fixture';
 if accessory_group is distinct from '990203aa' then raise exception 'Amazon spare group is missing from displayed rows';end if;
end $$;

-- Compare SKU sets even when the totals agree. A missing listing is only
-- observed without changing business state, even after repeated complete reports.
reset role;
update app.items set asin='B000000123',product_registered_at=now()-interval '2 days',
  marketplace_status_observed_at=now()-interval '2 days'
where title in ('parent grouping fixture','unrelated resale fixture');
do $$
declare
  original_sku text := (select sku from app.items where title='parent grouping fixture');
  missing_sku text := (select sku from app.items where title='unrelated resale fixture');
  lease uuid := gen_random_uuid();
  listings jsonb;
  result jsonb;
begin
  listings := jsonb_build_array(
    jsonb_build_object('sku',original_sku,'asin','B000000123','fulfillment','fba','state','active'),
    '{"sku":"outside-inventory","asin":"B000000456","fulfillment":"fba","state":"active"}'::jsonb
  );
  update app.amazon_seller_inventory_sync set lease_id=lease,lease_until=now()+interval '3 minutes',report_id='first'
  where account_id='amazon-2';
  result := app.apply_seller_inventory_report('amazon-2',lease,'first',now()-interval '7 hours',listings,0);
  if (result->>'missing_stopped')::int<>0 then raise exception 'Stopped listing on first absence';end if;
  if not exists(select 1 from app.read_amazon_listing_sync_status() s
    where s.account_id='amazon-2' and s.seller_count=2 and s.inventory_count=2
      and s.amazon_only=array['outside-inventory'] and s.inventory_only=array[missing_sku]) then
    raise exception 'Equal listing totals concealed unmatched SKUs';
  end if;

  update app.amazon_seller_inventory_sync set lease_id=lease,lease_until=now()+interval '3 minutes',report_id='cached'
  where account_id='amazon-2';
  result := app.apply_seller_inventory_report('amazon-2',lease,'cached',now()-interval '4 hours',listings,0);
  if (result->>'missing_stopped')::int<>0 then raise exception 'Stopped listing inside report cache window';end if;

  update app.amazon_seller_inventory_sync set lease_id=lease,lease_until=now()+interval '3 minutes',report_id='confirmed'
  where account_id='amazon-2';
  result := app.apply_seller_inventory_report('amazon-2',lease,'confirmed',now(),listings,0);
  if (result->>'missing_stopped')::int<>0 or not exists(select 1 from app.items where sku=missing_sku and status='出品中') then
    raise exception 'Missing SKU changed business state without confirmed order';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
  begin perform app.read_amazon_listing_sync_status();raise exception 'Non-admin could see Amazon comparison';
  exception when insufficient_privilege then null;end;
end $$;

reset role;
update app.items
set memo='fixture purchase note',malfunction_comment='fixture fault report',
    malfunction_reported_by=deliverer_id,malfunction_reported_at=now()-interval '2 hours'
where title in ('parent grouping fixture','unrelated resale fixture');
insert into app.item_comments(item_id,author_id,body,created_at)
select i.id,author.id,fixture.body,now()-fixture.age
from app.items i
cross join (values ('DD','fixture earlier deliverer message',interval '3 hours'),
                   ('AA','fixture later admin message',interval '10 minutes'),
                   ('HH','fixture unrelated deliverer message',interval '5 minutes'),
                   ('DD',E' \n\t',interval '1 minute')) as fixture(code,body,age)
join app.staff author on author.code=fixture.code
where i.title='parent grouping fixture';

set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare page jsonb;begin
  page:=app.read_inventory_page('management','{"queryField":"serial","query":"990203"}',50,'{}');
  if (select count(*) from jsonb_array_elements(page->'rows') d
      where d->>'title' in ('parent grouping fixture','unrelated resale fixture')
        and d->>'memo'='fixture purchase note' and d->>'latest_comment'='fixture fault report')<>2 then
    raise exception 'Assignee report did not appear, or an unrelated/blank message displaced it';
  end if;
end $$;

reset role;
insert into app.item_comments(item_id,author_id,body,created_at)
select id,deliverer_id,'fixture newer deliverer message',now()-interval '30 minutes'
from app.items where title='parent grouping fixture';
set local role authenticated;
do $$declare page jsonb;begin
  page:=app.read_inventory_page('management','{"queryField":"serial","query":"990203"}',50,'{}');
  if not exists(select 1 from jsonb_array_elements(page->'rows') d
                where d->>'title'='parent grouping fixture'
                  and d->>'latest_comment'='fixture newer deliverer message') then
    raise exception 'Newer assignee message did not take precedence';
  end if;
end $$;
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$begin
  if exists(select 1 from app.v_inventory_display
            where title='unrelated resale fixture' and latest_comment is not null) then
    raise exception 'A different assignee could see the fault report through the inventory view';
  end if;
end $$;

rollback;
