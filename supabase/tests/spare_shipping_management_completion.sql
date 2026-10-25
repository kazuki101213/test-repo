begin;
do $test$
declare aa uuid; hh uuid; dd uuid; spare uuid; result jsonb; task uuid; first_completion timestamptz; rejected boolean:=false;
begin
 select id into aa from app.staff where code='AA';
 select id into hh from app.staff where code='HH';
 select id into dd from app.staff where code='DD';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=aa limit 1),true);
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,marketplace,marketplace_item_id)
 values(hh,'リモコン',1000,'ヤフオク','management-completion-fixture') returning id into spare;
 result:=app.register_item_with_spare(jsonb_build_object('lot_seq',899983,'purchaser_id',aa,'deliverer_id',dd,
   'purchased_at','2026-10-26','title','management completion body','cost_amount',5000,'marketplace','ヤフオク','sales_channel','FBA'),spare);
 select id into strict task from app.spare_shipping_tasks where spare_id=spare;
 set local role authenticated;
 perform app.complete_spare_shipping(task);
 select management_completed_at into strict first_completion from app.spare_shipping_tasks where id=task;
 if first_completion is null or not exists(select 1 from app.spare_shipping_tasks where id=task and sent_at is null and completed_at is null)
 then raise exception 'Management completion must not ship or hide the holder task';end if;
 if not exists(select 1 from app.v_spare_shipping_tasks where id=task and management_completed_at=first_completion)
 then raise exception 'Pending holder task was lost';end if;
 perform app.complete_spare_shipping(task);
 if (select management_completed_at from app.spare_shipping_tasks where id=task)<>first_completion then raise exception 'Completion is not idempotent';end if;
 reset role;
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=hh limit 1),true);
 set local role authenticated;
 begin perform app.complete_spare_shipping(task);exception when insufficient_privilege then rejected:=true;end;
 if not rejected then raise exception 'Holder was allowed to acknowledge management tasks';end if;
 perform app.send_spare_shipping(task,'management-completion-tracking');
 if not exists(select 1 from app.spare_shipping_tasks where id=task and sent_at is not null and tracking_no='management-completion-tracking')
 then raise exception 'Management completion blocked the physical shipment';end if;
 if exists(select 1 from app.items where id=(result->>'id')::uuid and shipped_on is not null)
 then raise exception 'Management acknowledgement changed item shipment dates';end if;
end $test$;
rollback;
