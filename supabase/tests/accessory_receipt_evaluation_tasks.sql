begin;
select set_config('request.jwt.claim.sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role='admin' and s.is_active limit 1)::text,true);
set local role authenticated;
do $test$
declare parent uuid;child uuid;duplicate uuid;same_purchase uuid;late_child uuid;own_child uuid;imported_parent uuid;
begin
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,marketplace_item_id)
 values(990951,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'receipt parent fixture',100,'ヤフフリ','メルカリ','123','accessory-todo-parent') returning id into parent;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory,parent_item_id)
 select 990952+n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'receipt accessory fixture',10+n,
 market::app.marketplace,'メルカリ',purchase,true,parent
 from (values (0,'ヤフフリ','accessory-todo-child'),(1,'PayPayフリマ','accessory-todo-child'),(2,'PayPayフリマ','accessory-todo-parent'),(3,'メルカリ','accessory-todo-own')) f(n,market,purchase);
 select id into child from app.items where lot_seq=990952;
 select id into duplicate from app.items where lot_seq=990953;
 select id into same_purchase from app.items where lot_seq=990954;
 select id into own_child from app.items where lot_seq=990955;
 if exists(select 1 from app.receipt_evaluation_tasks where item_id in(parent,child,duplicate,same_purchase,own_child)) then raise exception 'Task before inspection';end if;
 perform app.perform_inventory_action(parent,'inspection_complete','検品中');
 if (select count(*) from app.v_receipt_evaluation_tasks where item_id in(parent,child,duplicate,same_purchase,own_child))<>3 then raise exception 'Expected parent plus two distinct accessory purchases';end if;
 if exists(select 1 from app.receipt_evaluation_tasks where item_id=same_purchase) then raise exception 'Same parent purchase enqueued twice';end if;
 if exists(select 1 from app.items where id in(child,duplicate,same_purchase,own_child) and (inspected_at is not null or cleaned_at is not null)) then raise exception 'Accessory inspection history modified';end if;
 -- An accessory's own real inspection keeps its task eligible after parent cancellation.
 update app.items set inspected_at=now(),cleaned_at=now() where id=own_child;
 perform app.perform_inventory_action(parent,'inspection_cancel','商品登録前');
 if exists(select 1 from app.v_receipt_evaluation_tasks where item_id in(parent,child,duplicate)) then raise exception 'Cancelled parent still ready';end if;
 if not exists(select 1 from app.v_receipt_evaluation_tasks where item_id=own_child) then raise exception 'Own inspected accessory lost task';end if;
 perform app.perform_inventory_action(parent,'inspection_complete','検品中');
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory)
 values(990956,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'linked later fixture',14,'ラクマ','メルカリ','accessory-todo-late',true) returning id into late_child;
 if exists(select 1 from app.receipt_evaluation_tasks where item_id=late_child) then raise exception 'Unlinked child enqueued';end if;
 update app.items set parent_item_id=parent where id=late_child;
 if not exists(select 1 from app.v_receipt_evaluation_tasks where item_id=late_child and is_accessory) then raise exception 'Later linked purchase omitted';end if;
 update app.items set parent_item_id=null where id=late_child;
 if exists(select 1 from app.v_receipt_evaluation_tasks where item_id=late_child) then raise exception 'Detached uninspected child visible';end if;
 update app.items set parent_item_id=parent where id=late_child;
 perform app.complete_receipt_evaluation_task(child);
 if exists(select 1 from app.receipt_evaluation_tasks where item_id in(child,duplicate) and completed_at is null) then raise exception 'Same purchase manual completion not grouped';end if;
 perform app.perform_inventory_action(parent,'inspection_cancel','商品登録前');
 perform app.perform_inventory_action(parent,'inspection_complete','検品中');
 if exists(select 1 from app.v_receipt_evaluation_tasks where item_id in(child,duplicate)) then raise exception 'Completed purchase revived';end if;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,inspected_at,cleaned_at)
 values(990957,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'imported dates fixture',100,'メルカリ','メルカリ','accessory-todo-import',now(),now()) returning id into imported_parent;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,marketplace_item_id,is_accessory,parent_item_id)
 values(990958,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'imported parent child fixture',10,'メルカリ','メルカリ','accessory-todo-import-child',true,imported_parent);
 if exists(select 1 from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id where i.lot_seq=990958) then raise exception 'Imported dates created task without inspection event';end if;
end $test$;
reset role;
insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
values('ラクマ','accessory-todo-late','fixture','succeeded',auth.uid());
set local role authenticated;
do $test$begin
 if exists(select 1 from app.v_receipt_evaluation_tasks where marketplace_item_id='accessory-todo-late') then raise exception 'Succeeded receipt stayed visible';end if;
 begin perform app.enqueue_accessory_receipt_tasks(null,now());raise exception 'Internal enqueue exposed';exception when insufficient_privilege then null;end;
end $test$;
reset role;
select set_config('request.jwt.claim.sub',(select p.user_id from app.profiles p join app.staff s on s.id=p.staff_id where s.role<>'admin' and s.is_active limit 1)::text,true);
set local role authenticated;
do $test$begin
 if exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq between 990951 and 990958) then raise exception 'Nonadmin task disclosure';end if;
 begin perform app.complete_receipt_evaluation_task((select id from app.items where marketplace_item_id='accessory-todo-child' limit 1));raise exception 'Nonadmin completion allowed';exception when insufficient_privilege then null;end;
end $test$;
set local role anon;
do $test$begin
 begin perform 1 from app.v_receipt_evaluation_tasks limit 1;raise exception 'Anonymous tasks exposed';exception when insufficient_privilege then null;end;
end $test$;
reset role;
rollback;
select 'passed: inherited readiness, distinct purchase deduplication, cancellation, later linking, unchanged inspection, grouped completion, success ledger and RLS' as result;
