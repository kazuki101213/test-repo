-- Exercise the real RPC/trigger for the damage-report status, without retained data.
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare kind text; body uuid; reply uuid; seq integer:=998350; buyer uuid; holder uuid;
begin
 select id into buyer from app.staff where code='AA';
 select id into holder from app.staff where code='II';
 foreach kind in array array['SONY×ヤフオク','ヤフオク その他','仕入先確認'] loop
  seq:=seq+1;
  insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status,malfunction_reported,condition)
  values(seq,buyer,holder,current_date,'damage instruction fixture',1230,'メルカリ','FBA','Amazon補填申請中',true,'非常に良い') returning id into body;
  -- Insert derives the initial stage; enter the explicit damage stage as the real report does.
  update app.items set status='Amazon補填申請中' where id=body;
  if not exists(select 1 from app.items where id=body and status='Amazon補填申請中') then raise exception 'Invalid damage fixture';end if;
  reply:=gen_random_uuid();
  perform app.send_malfunction_reply(reply,body,'CI fixture only',kind,'{}');
  perform app.send_malfunction_reply(reply,body,'CI fixture only',kind,'{}');
  if (select count(*) from app.item_comments where id=reply)<>1 then raise exception 'Duplicate instruction';end if;
  if kind='仕入先確認' then
   if not exists(select 1 from app.items where id=body and status='Amazon補填申請中' and sales_channel='FBA' and supplier_contact_requested_at is null) then raise exception 'Non-Yahoo damage reply changed workflow';end if;
  else
   if not exists(select 1 from app.items where id=body and status='商品登録前' and sales_channel='ヤフオク' and workflow_decision='yahoo' and workflow_previous_sales_channel='FBA') then raise exception 'Damage instruction did not prepare Yahoo listing';end if;
   if (select count(*) from app.spare_accessories where usage_note=seq::text)<>(case when kind='ヤフオク その他' then 0 else 1 end) then raise exception 'Damage remote handling changed';end if;
  end if;
 end loop;
 update app.items set status='販売済',sold_on=current_date where id=body;
 perform app.send_malfunction_reply(gen_random_uuid(),body,'CI sold guard','SONY×ヤフオク','{}');
 if not exists(select 1 from app.items where id=body and status='販売済' and sales_channel='FBA') then raise exception 'Sold item changed';end if;
end $$;
rollback;
