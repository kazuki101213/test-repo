-- Run only in the disposable CI database; never send real task messages.
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare kind text; grade app.item_condition; item uuid; original_sku text; seq integer:=997100;
 expected app.item_condition; reply uuid; spare_count bigint;
begin
 select count(*) into spare_count from app.spare_accessories;
 foreach kind in array array['Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク','Panasonic◯ヤフオク','SONY◯ヤフオク','SHARP◯ヤフオク','TOSHIBA◯ヤフオク','ヤフオク その他'] loop
  foreach grade in array array['ほぼ新品','非常に良い','良い','可']::app.item_condition[] loop
   seq:=seq+1;
   insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,status,malfunction_reported,condition,planned_price)
   values(seq,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Yahoo condition fixture',1000,'メルカリ','メルカリ','fixture','動作不良',true,grade,30000)
   returning id,sku into item,original_sku;
   reply:=gen_random_uuid();
   perform app.send_malfunction_reply(reply,item,'CI fixture only',kind,'{}');
   perform app.send_malfunction_reply(reply,item,'CI fixture only',kind,'{}');
   expected:=case when kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else grade end;
   if not exists(select 1 from app.items where id=item and condition=expected and sales_channel='ヤフオク' and status='商品登録前' and sku=original_sku and planned_price=30000 and workflow_previous_sales_channel='メルカリ' and workflow_decision='yahoo' and malfunction_resolved_at is not null) then
    raise exception 'Condition/identity/transition mismatch for % / %',kind,grade;
   end if;
   if (select count(*) from app.item_comments where id=reply)<>1 then raise exception 'Duplicate reply';end if;
  end loop;
 end loop;
 if (select count(*) from app.spare_accessories)<>spare_count then raise exception 'Reply unexpectedly moved accessories';end if;
 -- State and sold-item protection must still apply.
 update app.items set status='販売済',sold_on=current_date,condition='非常に良い' where id=item;
 perform app.send_malfunction_reply(gen_random_uuid(),item,'CI sold guard','SONY×ヤフオク','{}');
 if not exists(select 1 from app.items where id=item and status='販売済' and condition='非常に良い') then raise exception 'Sold guard changed';end if;
end $$;
set local request.jwt.claim.sub='33333333-3333-3333-3333-333333333333';
do $$begin
 begin
  perform app.send_malfunction_reply(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','CI forbidden','SONY×ヤフオク','{}');
  raise exception 'Unauthorized reply accepted';
 exception when insufficient_privilege then null;end;
end $$;
rollback;
