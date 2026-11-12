begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,asin,condition,cost_amount,marketplace,sales_channel,status,inspected_at)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date-10,'FBA dispatch fixture','B000000001','非常に良い',100,'ヤフオク','FBA2','商品登録前',now()
from generate_series(998671,998676) n;

insert into app.fba_inbound_plans(account,staff_id,name,created_by,created_at,stage,amazon_id,work)
select 'FBA2',id,'FBA dispatch '||n,'11111111-1111-1111-1111-111111111111',
 now()-interval '4 days','placement-confirmed','wf-dispatch-'||n,
 case when n=1 then jsonb_build_object(
  'dispatchRequestedAt',(current_date-2)::text||'T15:01:00Z','shipDate',(current_date+1)::text)
  else '{}'::jsonb end
from app.staff cross join generate_series(1,3) n where code='DD';

insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel,released_at)
select p.id,i.id,i.sku,i.asin,i.title,i.condition::text,i.sales_channel,
 case when i.lot_seq=998674 then now() end
from app.items i join app.fba_inbound_plans p
 on p.amazon_id='wf-dispatch-'||case when i.lot_seq=998675 then '2' when i.lot_seq=998676 then '3' else '1' end
where i.lot_seq between 998671 and 998676;
update app.items set shipped_on=current_date-4 where lot_seq=998672;
update app.items set sales_channel='自己発送2' where lot_seq=998673;
update app.items set cost_amount=130 where lot_seq in (998671,998674);

set local role service_role;
update app.fba_inbound_plans set pending=jsonb_build_object('action','confirmTransport','at',(current_date-1)::text||'T15:01:00Z')
where amazon_id in ('wf-dispatch-1','wf-dispatch-2');
update app.fba_inbound_plans set pending=null where amazon_id='wf-dispatch-1';
reset role;
do $$begin
 if (select shipped_on from app.items where lot_seq=998671) is not null then
   raise exception 'Failed FBA confirmation set a date';
 end if;
end$$;

set local role service_role;
update app.fba_inbound_plans set pending=jsonb_build_object('action','confirmTransport','at',(current_date-1)::text||'T15:01:00Z')
where amazon_id='wf-dispatch-1';
update app.fba_inbound_plans set stage='ready',pending=null where amazon_id in ('wf-dispatch-1','wf-dispatch-2','wf-dispatch-3');
reset role;

do $$begin
 if (select shipped_on from app.items where lot_seq=998671) is distinct from current_date-1 then
   raise exception 'Combined FBA button did not use its original JST date';
 end if;
 if (select shipped_on from app.items where lot_seq=998672) is distinct from current_date-4 then
   raise exception 'Existing dispatch date was overwritten';
 end if;
 if exists(select 1 from app.items where lot_seq in (998673,998674,998676) and shipped_on is not null) then
   raise exception 'A changed, released, or unconfirmed item was dated';
 end if;
 if (select shipped_on from app.items where lot_seq=998675) is distinct from current_date then
   raise exception 'Separate transport confirmation did not use its JST date';
 end if;
end$$;
do $$
declare i app.items; draft_id uuid;
begin
 select * into strict i from app.items where lot_seq=998674;
 draft_id:=app.create_fba_inbound_draft('11111111-1111-1111-1111-111111111111',array[i.id]);
 if not exists(select 1 from app.fba_inbound_items f where f.plan_id=draft_id and f.item_id=i.id
   and f.sku<>i.sku and app.inventory_sku_matches(i.id,i.sku,f.sku)) then
  raise exception 'New FBA draft discarded the prior Amazon SKU';
 end if;
end $$;
rollback;
