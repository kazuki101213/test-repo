begin;
do $test$
declare buyer uuid; holder uuid; worker uuid; parent app.items; spare uuid; result jsonb; accessory app.items; rejected boolean:=false;
begin
 select id into buyer from app.staff where code='AA';
 select id into holder from app.staff where code='HH';
 select id into worker from app.staff where code='DD';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.items(lot_seq,purchaser_id,deliverer_id,title,cost_amount,marketplace,purchased_at,sales_channel)
 values(899989,buyer,worker,'spare holder regression body',5000,'ヤフオク','2026-10-21','FBA') returning * into parent;
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id)
 values(holder,'リモコン',1757,'2026-05-02','ヤフオク','holder-independent-test') returning id into spare;
 set local role authenticated;
 result:=app.register_item_with_spare(jsonb_build_object('lot_seq',parent.lot_seq,'is_accessory',true,'purchaser_id',buyer,'deliverer_id',worker,'work_stream','付属品','title','リモコン','cost_amount',1757,'marketplace','ヤフオク','marketplace_item_id','holder-independent-test','purchased_at','2026-05-02','sales_channel','FBA'),spare);
 select * into strict accessory from app.items where id=(result->>'id')::uuid;
 if accessory.parent_item_id is distinct from parent.id or accessory.purchaser_id is distinct from buyer or not accessory.is_accessory
 then raise exception 'Accessory parent or buyer changed';end if;
 if not exists(select 1 from app.spare_shipping_tasks where spare_id=spare and item_id=accessory.id and accessory_item_id=accessory.id and owner_staff_id=holder and recipient_staff_id=worker)
 then raise exception 'Holder-to-recipient shipping task missing';end if;
 if not exists(select 1 from app.spare_accessories where id=spare and owner_staff_id=holder and used_for_item_id=accessory.id)
 then raise exception 'Source holder or allocation changed';end if;
 -- Source mismatch remains rejected even when buyer and holder differ legitimately.
 update app.items set title='wrong source title' where id=accessory.id;
 begin perform app.queue_spare_shipping(spare,accessory.id,accessory.id);
 exception when sqlstate '22023' then rejected:=true;end;
 if not rejected then raise exception 'Source mismatch accepted';end if;
end $test$;
rollback;
