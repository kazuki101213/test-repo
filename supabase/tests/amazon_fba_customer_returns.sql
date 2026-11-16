begin;
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,work_stream)
values ('998845-AADD-20261020-1234',998845,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date-45,'FBA recorder return fixture',12340,'ヤフオク','FBA1','ブルーレイ'),
 ('998846-AAII-20261020-567',998846,(select id from app.staff where code='AA'),(select id from app.staff where code='II'),
 current_date-45,'FBA small item return fixture',5670,'ヤフオク','FBA1','その他');

set local role service_role;
do $$
declare
 job jsonb:=app.claim_amazon_fba_return_sync('amazon-1');
 lease uuid:=(job->>'lease_id')::uuid;
 payload jsonb;
 result jsonb;
 today date:=(now() at time zone 'Asia/Tokyo')::date;
begin
 if lease is null or app.claim_amazon_fba_return_sync('amazon-1') is not null then
  raise exception 'Amazon report lease is not exclusive';
 end if;
 update app.amazon_fba_return_sync set report_id='fixture' where account_id='amazon-1';
 payload:=jsonb_build_array(jsonb_build_object('amazon_order_id','111-1234567-1234567',
  'source_sku','998845-AADD-20261020-1234','returned_on',today-1,'quantity',1,
  'reason','DEFECTIVE','disposition','CUSTOMER_DAMAGED','lpn','LPN1'));
 result:=app.import_amazon_fba_customer_returns('amazon-1',lease,'fixture',payload);
 if result->>'imported'<>'1' then raise exception 'Amazon return did not register: %',result; end if;
 result:=app.import_amazon_fba_customer_returns('amazon-1',lease,'fixture',payload);
 if result->>'imported'<>'0' then raise exception 'Same return registered twice'; end if;
 payload:=jsonb_set(payload,'{0,amazon_order_id}','"111-1234567-7654321"');
 result:=app.import_amazon_fba_customer_returns('amazon-1',lease,'fixture',payload);
 if result->>'imported'<>'1' then raise exception 'A second order did not register: %',result; end if;
 payload:=jsonb_set(jsonb_set(payload,'{0,amazon_order_id}','"111-1234567-1234568"'),'{0,quantity}','2');
 result:=app.import_amazon_fba_customer_returns('amazon-1',lease,'fixture',payload);
 if result->>'review'<>'1' or result->>'imported'<>'0' then raise exception 'Ambiguous quantity was imported'; end if;
 payload:=jsonb_build_array(jsonb_build_object('amazon_order_id','111-1234567-4321234',
  'source_sku','998846-AAII-20261020-567','returned_on',today-1,'quantity',1,
  'reason','UNWANTED_ITEM','disposition','SELLABLE','lpn','LPN2'));
 result:=app.import_amazon_fba_customer_returns('amazon-1',lease,'fixture',payload);
 if result->>'imported'<>'1' then raise exception 'Small item return did not register: %',result; end if;
end;
$$;

set local role postgres;
do $$
declare
  return_day date:=(now() at time zone 'Asia/Tokyo')::date-1;
  sku_day text:=to_char(return_day,'YYYYMMDD');
begin
 if (select count(*) from app.items where lot_seq=998845 and marketplace='Amazon返品')<>2
  or exists(select 1 from app.items where lot_seq=998845 and marketplace='Amazon返品' and
    (sku not in ('998845a-AAII-'||sku_day||'-1234','998845aa-AAII-'||sku_day||'-1234')
      or status<>'Amazon返送依頼' or tracking_no is not null or amazon_returned_on is not null
      or purchased_at is distinct from return_day or return_reason is distinct from 'DEFECTIVE'
      or deliverer_id is distinct from (select id from app.staff where code='II'))) then
  raise exception 'Amazon return numbering or workflow differs from the normal return';
 end if;
 if not exists(select 1 from app.items where lot_seq=998846 and marketplace='Amazon返品'
    and sku='998846a-AADD-'||sku_day||'-567' and purchased_at=return_day
    and return_reason='UNWANTED_ITEM' and deliverer_id=(select id from app.staff where code='DD')) then
  raise exception 'Small item return uses the wrong date, assignee, reason or SKU';
 end if;
 if has_function_privilege('authenticated','app.import_amazon_fba_customer_returns(text,uuid,text,jsonb)','EXECUTE')
  or has_function_privilege('anon','app.claim_amazon_fba_return_sync(text)','EXECUTE') then
  raise exception 'Amazon return writes are exposed to browser users';
 end if;
end;
$$;
rollback;
