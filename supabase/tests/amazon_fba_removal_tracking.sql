begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select fixture.lot,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 (now() at time zone 'Asia/Tokyo')::date-3,'Amazon removal tracking fixture',0,
 fixture.marketplace,'FBA1',fixture.tracking_no
from (values
 (998850,'Amazon返品'::app.marketplace,null::text),
 (998851,'Amazon返品',null),
 (998852,'Amazon返品','MANUAL0001'),
 (998853,'動作品Amazon返品','X000FNSKU1'),
 (998854,'Amazon返品',null)
) fixture(lot,marketplace,tracking_no);

insert into app.amazon_fba_return_sync(account_id,import_from)
values ('amazon-1',current_date-7) on conflict do nothing;
insert into app.amazon_fba_customer_returns(account_id,amazon_order_id,source_sku,returned_on,quantity,item_id,registered_at)
select 'amazon-1','111-0000000-'||lot_seq,'FBA-FIXTURE-'||lot_seq,(now() at time zone 'Asia/Tokyo')::date-3,1,id,now()
from app.items where lot_seq between 998850 and 998854;
insert into app.amazon_fba_customer_returns(account_id,amazon_order_id,source_sku,returned_on,quantity)
values ('amazon-1','111-0000000-998855','FBA-FIXTURE-998854',(now() at time zone 'Asia/Tokyo')::date-2,2);

set local role service_role;
do $$
declare
  job jsonb:=app.claim_amazon_fba_removal_sync('amazon-1');
  lease uuid:=(job->>'lease_id')::uuid;
  today date:=(now() at time zone 'Asia/Tokyo')::date;
  shipment jsonb:=jsonb_build_object('removal_order_id','RK0023','requested_on',today-1,
    'shipped_on',today,'quantity',1,'tracking_no','001234567890','carrier','YAMATO');
  rows jsonb;
  result jsonb;
begin
  if lease is null or app.claim_amazon_fba_removal_sync('amazon-1') is not null then
    raise exception 'Removal report lease is not exclusive';
  end if;
  update app.amazon_fba_removal_sync set report_id='removal-test' where account_id='amazon-1';
  rows:=jsonb_build_array(
    jsonb_build_object('source_sku','FBA-FIXTURE-998850','shipments',jsonb_build_array(shipment)),
    jsonb_build_object('source_sku','FBA-FIXTURE-998851','shipments',jsonb_build_array(shipment,shipment||'{"tracking_no":""}')),
    jsonb_build_object('source_sku','FBA-FIXTURE-998852','shipments',jsonb_build_array(shipment)),
    jsonb_build_object('source_sku','FBA-FIXTURE-998853','shipments',jsonb_build_array(shipment)),
    jsonb_build_object('source_sku','FBA-FIXTURE-998854','shipments',jsonb_build_array(shipment)));
  result:=app.import_amazon_fba_removal_tracking('amazon-1',lease,'removal-test',rows);
  if result->>'updated'<>'1' or result->>'review'<>'3' then raise exception 'Unexpected removal import: %',result; end if;
  result:=app.import_amazon_fba_removal_tracking('amazon-1',lease,'removal-test',rows);
  if result->>'updated'<>'0' then raise exception 'Removal import updated a second time'; end if;
end;
$$;

set local role postgres;
do $$
begin
  if not exists(select 1 from app.items where lot_seq=998850 and tracking_no='001234567890' and status='Amazon返送依頼')
    or not exists(select 1 from app.items where lot_seq=998852 and tracking_no='MANUAL0001')
    or not exists(select 1 from app.items where lot_seq=998853 and tracking_no='X000FNSKU1')
    or exists(select 1 from app.items where lot_seq in (998851,998854) and tracking_no is not null)
    or (select count(*) from app.amazon_fba_customer_returns where removal_order_id='RK0023'
      and removal_carrier='YAMATO' and removal_tracking_no='001234567890')<>1 then
    raise exception 'Removal tracking altered a workflow or used an ambiguous return';
  end if;
  if has_function_privilege('authenticated','app.import_amazon_fba_removal_tracking(text,uuid,text,jsonb)','EXECUTE')
    or has_function_privilege('anon','app.claim_amazon_fba_removal_sync(text)','EXECUTE') then
    raise exception 'Removal tracking is exposed to frontend users';
  end if;
end;
$$;
rollback;
