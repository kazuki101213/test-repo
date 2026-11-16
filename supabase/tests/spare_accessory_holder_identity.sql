begin;
do $test$
declare buyer uuid; actual_buyer uuid; holder uuid; worker uuid; parent app.items; spare uuid;
        recycled uuid; result jsonb; accessory app.items; bundled app.items; rejected boolean:=false;
begin
 select id into buyer from app.staff where code='AA';
 select id into actual_buyer from app.staff where code='EE';
 select id into holder from app.staff where code='HH';
 select id into worker from app.staff where code='DD';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.items(lot_seq,purchaser_id,deliverer_id,title,cost_amount,marketplace,purchased_at,sales_channel)
 values(899989,buyer,worker,'spare holder regression body',5000,'ヤフオク','2026-10-21','FBA') returning * into parent;
 insert into app.spare_accessories(owner_staff_id,purchaser_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id,tracking_no)
 values(holder,actual_buyer,'リモコン',1757,'2026-05-02','ヤフオク','holder-independent-test','spare-tracking') returning id into spare;
 set local role authenticated;
 -- The selected spare must win when the open form still has its default marketplace and a blank item ID.
 result:=app.register_item_with_spare(jsonb_build_object('sku','899989-AADD-20261116-100','lot_seq',parent.lot_seq,'is_accessory',true,'purchaser_id',buyer,'deliverer_id',worker,'work_stream','付属品','title','リモコン','cost_amount',1000,'marketplace','メルカリ','marketplace_url','https://jp.mercari.com/item/m12345678901','purchased_at','2026-11-16','sales_channel','FBA'),spare);
 select * into strict accessory from app.items where id=(result->>'id')::uuid;
 if accessory.parent_item_id is distinct from parent.id or accessory.purchaser_id is distinct from actual_buyer
    or split_part(accessory.sku,'-',2) <> 'EEDD' or not accessory.is_accessory
 then raise exception 'Accessory parent or buyer changed';end if;
 if accessory.marketplace is distinct from 'ヤフオク'::app.marketplace
    or accessory.marketplace_item_id is distinct from 'holder-independent-test'
    or accessory.marketplace_url is not null
    or accessory.purchased_at is distinct from date '2026-05-02'
    or accessory.cost_amount is distinct from 1757
    or accessory.tracking_no is distinct from 'spare-tracking'
 then raise exception 'A stale form overrode the selected spare purchase';end if;
 if not exists(select 1 from app.spare_shipping_tasks where spare_id=spare and item_id=accessory.id and accessory_item_id=accessory.id and owner_staff_id=holder and recipient_staff_id=worker)
 then raise exception 'Holder-to-recipient shipping task missing';end if;
 if not exists(select 1 from app.spare_accessories where id=spare and owner_staff_id=holder and used_for_item_id=accessory.id)
 then raise exception 'Source holder or allocation changed';end if;
 -- Source mismatch remains rejected even when buyer and holder differ legitimately.
 update app.items set title='wrong source title' where id=accessory.id;
 begin perform app.queue_spare_shipping(spare,accessory.id,accessory.id);
 exception when sqlstate '22023' then rejected:=true;end;
 if not rejected then raise exception 'Source mismatch accepted';end if;

 -- Sending an allocated remote back to spares retains its purchaser.
 update app.items set title='リモコン' where id=accessory.id;
 recycled:=app.move_inventory_accessory_to_spares(accessory.id,jsonb_build_object(
   'usage_note',parent.lot_seq::text,'title','リモコン','owner_staff_id',worker,
   'marketplace','ヤフオク','marketplace_item_id','holder-independent-test'));
 if not exists(select 1 from app.spare_accessories where id=recycled and owner_staff_id=worker and purchaser_id=actual_buyer)
 then raise exception 'Inventory transfer changed the original buyer';end if;

 -- Adding the spare while creating a body must keep both purchase identities.
 result:=app.register_item_with_spare(jsonb_build_object('lot_seq',899988,'purchaser_id',buyer,'deliverer_id',worker,
   'purchased_at','2026-10-22','title','new body with spare','cost_amount',1000,'marketplace','ヤフオク',
   'sales_channel','FBA','work_stream','ブルーレイ'),recycled);
 select * into strict bundled from app.items where parent_item_id=(result->>'id')::uuid and is_accessory;
 if bundled.purchaser_id is distinct from actual_buyer or
    (select purchaser_id from app.items where id=bundled.parent_item_id) is distinct from buyer
 then raise exception 'Bundled registration assigned a holder or body purchaser to the spare';end if;
end $test$;
rollback;
