begin;
select set_config('request.jwt.claim.sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active limit 1)::text,true);
set local role authenticated;
do $test$
declare parent uuid; normal_child uuid; allocated_child uuid; direct_child uuid; linked_child uuid; staff_id uuid;
begin
 select id into staff_id from app.staff where code='AA';
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,marketplace_item_id)
 values(990961,staff_id,(select id from app.staff where code='DD'),current_date,'spare receipt parent fixture',100,'メルカリ','メルカリ','123','spare-receipt-parent') returning id into parent;
 insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory,parent_item_id)
 select (990962+n)::text||repeat('a',n+1)||'-AADD-'||to_char(current_date-n,'YYYYMMDD')||'-1',990962+n,staff_id,(select id from app.staff where code='DD'),current_date-n,'spare receipt child fixture',10+n,'メルカリ','メルカリ',purchase,true,parent
 from (values(0,'spare-receipt-normal'),(1,'spare-receipt-allocated'),(2,'spare-receipt-direct'),(3,'spare-receipt-linked')) f(n,purchase);
 select id into normal_child from app.items where lot_seq=990962;
 select id into allocated_child from app.items where lot_seq=990963;
 select id into direct_child from app.items where lot_seq=990964;
 select id into linked_child from app.items where lot_seq=990965;
 -- Same-owner allocations have no shipping task; their purchase identity still identifies the child.
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id,used_for_item_id)
 values(staff_id,'allocated receipt fixture',10,current_date,'メルカリ','spare-receipt-allocated',parent),
       (staff_id,'direct receipt fixture',10,current_date,'メルカリ','spare-receipt-direct',direct_child);
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id,linked_item_id)
 values(staff_id,'linked receipt fixture',10,current_date,'メルカリ','spare-receipt-linked',linked_child);
 perform app.perform_inventory_action(parent,'inspection_complete','検品中');
 if (select count(*) from app.v_receipt_evaluation_tasks where item_id in(parent,normal_child,allocated_child,direct_child,linked_child))<>2 then raise exception 'Only body and ordinary purchase should be visible';end if;
 if not exists(select 1 from app.v_receipt_evaluation_tasks where item_id=parent) or not exists(select 1 from app.v_receipt_evaluation_tasks where item_id=normal_child) then raise exception 'Body or ordinary sibling was excluded';end if;
 if exists(select 1 from app.receipt_evaluation_tasks where item_id in(allocated_child,direct_child,linked_child)) then raise exception 'Spare-origin child was enqueued';end if;
 -- Preserve historical requests, while hiding them even when the accessory has its own inspection.
 insert into app.receipt_evaluation_tasks(item_id,requested_at) values(allocated_child,now()),(direct_child,now()),(linked_child,now());
 update app.items set inspected_at=now(),cleaned_at=now() where id in(allocated_child,direct_child,linked_child);
 if exists(select 1 from app.v_receipt_evaluation_tasks where item_id in(allocated_child,direct_child,linked_child)) then raise exception 'Legacy spare task remained visible';end if;
 begin perform app.complete_receipt_evaluation_task(direct_child);raise exception 'Stale spare task could be completed';exception when invalid_parameter_value then null;end;
 if exists(select 1 from app.receipt_evaluation_tasks where item_id in(allocated_child,direct_child,linked_child) and completed_at is not null) then raise exception 'Excluded history was marked completed';end if;
 if has_function_privilege('anon','app.receipt_item_is_spare_accessory(app.items)','EXECUTE') then raise exception 'Anonymous helper access';end if;
end $test$;
rollback;
