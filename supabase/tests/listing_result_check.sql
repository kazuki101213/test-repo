begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,inspected_at)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'result check fixture',1000,'ヤフオク','メルカリ','fixture',now() from generate_series(993201,993208) n;
insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status)
select gen_random_uuid(),id,(select id from app.staff where code='AA'),'listing','メルカリ','mercari-2',status,updated_at,jsonb_build_object('title','【'||split_part(sku,'-',1)||'】 fixture'),'uncertain' from app.items where lot_seq between 993201 and 993208;
create temporary table reconciliation_probe as select o.id,o.item_id,i.lot_seq,jsonb_build_object('external_id','m'||i.lot_seq,'url','https://jp.mercari.com/item/m'||i.lot_seq,'verified_title',o.payload->>'title','verified_serial',split_part(i.sku,'-',1),'observed_at',clock_timestamp()) proof from app.seller_operations o join app.items i on i.id=o.item_id where i.lot_seq between 993201 and 993208;
grant select on reconciliation_probe to authenticated;
create function pg_temp.reject_check(op uuid,proof jsonb) returns void language plpgsql as $$begin
 begin perform app.extension_finish_listing_result_check(op,proof);exception when others then return;end;
 raise exception 'Invalid reconciliation accepted: %',op;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 begin perform app.request_listing_result_check((select item_id from reconciliation_probe limit 1));raise exception 'Other assignee accepted';exception when insufficient_privilege then null;end;
 begin perform app.extension_claim_listing_result_check((select id from reconciliation_probe limit 1),'mercari-2');raise exception 'Other assignee worker accepted';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$declare p reconciliation_probe;begin
 for p in select * from reconciliation_probe loop
  if exists(select 1 from jsonb_array_elements(app.extension_seller_queue(array['mercari-2'])) q where q->>'id'=p.id::text) then raise exception 'Unrequested check queued';end if;
  perform app.request_listing_result_check(p.item_id);
  if app.extension_claim_seller_operation(p.id,'mercari-2') then raise exception 'Uncertain operation reclaimed for publishing';end if;
  if app.extension_claim_listing_result_check(p.id,'mercari-1') then raise exception 'Wrong account claimed';end if;
  if not app.extension_claim_listing_result_check(p.id,'mercari-2') then raise exception 'Result check not claimed';end if;
  if app.extension_claim_listing_result_check(p.id,'mercari-2') then raise exception 'Duplicate check claimed';end if;
  if app.seller_operation_context(p.item_id)->'operations'->0->'result'->>'read_check_state' is distinct from 'running' then raise exception 'UI progress missing';end if;
 end loop;
 for p in select * from reconciliation_probe where lot_seq=993201 loop
  perform pg_temp.reject_check(p.id,p.proof||jsonb_build_object('verified_title','wrong'));
  perform pg_temp.reject_check(p.id,p.proof||jsonb_build_object('verified_serial','993201b'));
  perform pg_temp.reject_check(p.id,p.proof||jsonb_build_object('url','https://example.com/item/m993201'));
  perform pg_temp.reject_check(p.id,p.proof||jsonb_build_object('observed_at',clock_timestamp()-interval '1 hour'));
  perform app.extension_finish_listing_result_check(p.id,p.proof);
  perform app.extension_finish_listing_result_check(p.id,p.proof);
  if (select status from app.items where id=p.item_id)<>'出品中' or (select status from app.seller_operations where id=p.id)<>'succeeded' then raise exception 'Valid result not applied';end if;
  if (select count(*) from app.seller_listings where item_id=p.item_id)<>1 then raise exception 'Duplicate listing created';end if;
 end loop;
 for p in select * from reconciliation_probe where lot_seq=993202 loop
  perform app.extension_finish_listing_result_check(p.id,'{"note":"not found"}');
  if (select status from app.seller_operations where id=p.id)<>'uncertain' then raise exception 'Failure became publishable';end if;
  if exists(select 1 from jsonb_array_elements(app.extension_seller_queue(array['mercari-2'])) q where q->>'id'=p.id::text) then raise exception 'Failed check retried automatically';end if;
 end loop;
end $$;
set local role postgres;
-- Item revisions use now(); emulate an earlier request across transaction boundaries.
update app.seller_operations set expected_updated_at=expected_updated_at-interval '1 second' where item_id=(select item_id from reconciliation_probe where lot_seq=993203);
update app.items set sold_on=current_date where lot_seq=993204;
update app.items set status='動作不良' where lot_seq=993205;
insert into app.seller_listings(item_id,channel,account_id,external_id,url) select item_id,'メルカリ','mercari-1','mold','https://jp.mercari.com/item/mold' from reconciliation_probe where lot_seq=993206;
insert into app.seller_listings(item_id,channel,account_id,external_id,url) select item_id,'メルカリ','mercari-2','m993207','https://jp.mercari.com/item/m993207' from reconciliation_probe where lot_seq=993208;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select pg_temp.reject_check(id,proof) from reconciliation_probe where lot_seq between 993203 and 993207;
rollback;
