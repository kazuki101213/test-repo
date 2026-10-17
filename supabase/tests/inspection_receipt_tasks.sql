begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no,marketplace_item_id)
select 993200+n,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'receipt todo fixture',1000,market::app.marketplace,'メルカリ','123','fixture-'||n
from (values(1,'メルカリ'),(2,'ヤフオク'),(3,'ヤフフリ'),(4,'ラクマ'),(5,'PayPayフリマ')) fixture(n,market);
set local request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select app.perform_inventory_action(id,'inspection_complete','検品中') from app.items where lot_seq between 993201 and 993205;
do $$begin
 if exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq between 993201 and 993205) then raise exception 'Deliverer read admin receipt tasks';end if;
 begin perform app.read_resource_snapshot('receipt_tasks');raise exception 'Receipt resource leaked';exception when insufficient_privilege then null;end;
 begin perform app.complete_receipt_evaluation_task((select id from app.items where lot_seq=993201));raise exception 'Deliverer completed admin task';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$begin
 if (select count(*) from app.v_receipt_evaluation_tasks where lot_seq between 993201 and 993205)<>5 then raise exception 'Inspection did not create all four-site receipt tasks';end if;
 if jsonb_array_length(app.read_resource_snapshot('receipt_tasks')->'rows')<5 then raise exception 'Snapshot omitted receipt tasks';end if;
end $$;
select app.perform_inventory_action(id,'inspection_cancel','商品登録前') from app.items where lot_seq=993201;
do $$begin if exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq=993201) then raise exception 'Cancelled inspection kept receipt task';end if;end $$;
select app.perform_inventory_action(id,'inspection_complete','検品中') from app.items where lot_seq=993201;
do $$begin if (select count(*) from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id where i.lot_seq=993201)<>1 then raise exception 'Inspection duplicated task';end if;end $$;
select app.complete_receipt_evaluation_task(id) from app.items where lot_seq=993201;
select app.complete_receipt_evaluation_task(id) from app.items where lot_seq=993201;
do $$begin if exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq=993201) then raise exception 'Manual completion stayed visible';end if;end $$;
set local role postgres;
insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
values('Yahoo!フリマ','fixture-5','fixture account','succeeded','11111111-1111-1111-1111-111111111111');
insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
values('Yahoo!フリマ','fixture-3','fixture account','unknown','11111111-1111-1111-1111-111111111111');
set local role authenticated;
do $$begin
 if exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq=993205) then raise exception 'Extension completion not hidden through alias';end if;
 if not exists(select 1 from app.v_receipt_evaluation_tasks where lot_seq=993203) then raise exception 'Unknown result silently completed';end if;
end $$;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,tracking_no)
select 993206,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'Amazon receipt excluded',0,'Amazon返品','FBA',null;
select app.perform_inventory_action(id,'return_request_complete',status) from app.items where lot_seq=993206;
select app.perform_inventory_action(id,'inspection_complete',status) from app.items where lot_seq=993206;
do $$begin if exists(select 1 from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id where i.lot_seq=993206) then raise exception 'Amazon return received marketplace evaluation task';end if;end $$;
rollback;
