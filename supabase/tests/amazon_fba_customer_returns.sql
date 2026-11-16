begin;
insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
values ('998845-AADD-20261020-1234',998845,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date-45,'FBA return fixture',12340,'ヤフオク','FBA1');

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
end;
$$;

set local role postgres;
do $$
begin
 if (select count(*) from app.items where lot_seq=998845 and marketplace='Amazon返品')<>2
  or exists(select 1 from app.items where lot_seq=998845 and marketplace='Amazon返品' and
    (sku not in ('998845a-AADD-20261020-1234','998845aa-AADD-20261020-1234')
      or status<>'Amazon返送依頼' or tracking_no is not null or amazon_returned_on is null)) then
  raise exception 'Amazon return numbering or workflow differs from the normal return';
 end if;
 if has_function_privilege('authenticated','app.import_amazon_fba_customer_returns(text,uuid,text,jsonb)','EXECUTE')
  or has_function_privilege('anon','app.claim_amazon_fba_return_sync(text)','EXECUTE') then
  raise exception 'Amazon return writes are exposed to browser users';
 end if;
end;
$$;
rollback;
