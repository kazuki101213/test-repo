begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,asin,condition,cost_amount,marketplace,sales_channel,status,inspected_at)
select n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date-10,'FBA dispatch fixture','B000000001','非常に良い',100,'ヤフオク','FBA2','商品登録前',now()
from generate_series(998671,998678) n where n<>998677;

insert into app.fba_inbound_plans(account,staff_id,name,created_by,created_at,stage,amazon_id,work)
select 'FBA2',id,'FBA dispatch '||n,'11111111-1111-1111-1111-111111111111',
 now()-interval '4 days','placement-confirmed','wf-dispatch-'||n,
 case when n=1 then jsonb_build_object(
  'dispatchRequestedAt',(current_date-2)::text||'T15:01:00Z','shipDate',(current_date+1)::text)
  else '{}'::jsonb end
from app.staff cross join generate_series(1,4) n where code='DD';

insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel,released_at)
select p.id,i.id,i.sku,i.asin,i.title,i.condition::text,i.sales_channel,
 case when i.lot_seq=998674 then now() end
from app.items i join app.fba_inbound_plans p
 on p.amazon_id='wf-dispatch-'||case when i.lot_seq=998675 then '2' when i.lot_seq=998676 then '3' when i.lot_seq=998678 then '4' else '1' end
where i.lot_seq between 998671 and 998678 and i.lot_seq<>998677;
update app.items set shipped_on=current_date-4 where lot_seq=998672;
update app.items set sales_channel='自己発送2' where lot_seq=998673;

set local role service_role;
update app.fba_inbound_plans set pending=jsonb_build_object('action','confirmTransport','op','confirm-op','at',(current_date-1)::text||'T15:01:00Z')
where amazon_id='wf-dispatch-1';
update app.fba_inbound_plans set pending=jsonb_build_object('action','confirmTransport','op','confirm-op','at',(current_date-2)::text||'T15:01:00Z')
where amazon_id in ('wf-dispatch-2','wf-dispatch-3','wf-dispatch-4');
update app.fba_inbound_plans set pending=pending||jsonb_build_object('transportStillPendingAt',(current_date-1)::text||'T15:05:00Z')
where amazon_id='wf-dispatch-2';
update app.fba_inbound_plans set pending=null where amazon_id='wf-dispatch-1';
reset role;
do $$begin
 if (select shipped_on from app.items where lot_seq=998671) is not null then
   raise exception 'Failed FBA confirmation set a date';
 end if;
end$$;

set local role service_role;
update app.fba_inbound_plans set pending=jsonb_build_object('action','confirmTransport','op','confirm-op','at',(current_date-1)::text||'T15:01:00Z')
where amazon_id='wf-dispatch-1';
update app.fba_inbound_plans set stage='ready',pending=null,
 work=work||jsonb_build_object('transportConfirmationObservedAt',(current_date-1)::text||'T15:10:00Z')
where amazon_id in ('wf-dispatch-1','wf-dispatch-2','wf-dispatch-3');
update app.fba_inbound_plans set pending=pending-'op'||jsonb_build_object('at',(current_date-1)::text||'T15:01:00Z')
where amazon_id='wf-dispatch-4';
update app.fba_inbound_plans set stage='ready',pending=null,
 work=work||jsonb_build_object('transportConfirmationObservedAt',(current_date-1)::text||'T15:10:00Z')
where amazon_id='wf-dispatch-4';
reset role;

do $$begin
 if (select shipped_on from app.items where lot_seq=998671) is distinct from current_date then
   raise exception 'FBA confirmation used the button date or the planned date';
 end if;
 if (select shipped_on from app.items where lot_seq=998672) is distinct from current_date-4 then
   raise exception 'Existing dispatch date was overwritten';
 end if;
 if exists(select 1 from app.items where lot_seq in (998673,998674,998676,998678) and shipped_on is not null) then
   raise exception 'A changed, released, ambiguous, or unlinked item was dated';
 end if;
 if (select shipped_on from app.items where lot_seq=998675) is distinct from current_date then
   raise exception 'A known pending check did not narrow the confirmation date to JST day';
 end if;
end$$;
rollback;
