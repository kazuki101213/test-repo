begin;
do $test$
declare buyer uuid; worker uuid; spare uuid; result jsonb; body app.items; accessory app.items; other app.items; rejected boolean:=false;
begin
 select id into buyer from app.staff where code='AA';
 select id into worker from app.staff where code='HH';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id,manufacturer)
 values(buyer,'リモコン',0,'2026-05-30','Amazon返品','explicit-spare-test','SONY') returning id into spare;
 -- The actual RPC creates the new Yahoo main item, allocates the spare, then inserts its accessory.
 result:=app.register_item_with_spare(jsonb_build_object('lot_seq',899991,'purchaser_id',buyer,'deliverer_id',worker,
  'work_stream','ブルーレイ','purchased_at','2026-10-16','title','BDZ-ZW550','cost_amount',5000,
  'marketplace','ヤフオク','marketplace_item_id','explicit-body-test','sales_channel','FBA'),spare);
 select * into strict body from app.items where id=(result->>'id')::uuid;
 select * into strict accessory from app.items where sku=result->>'accessory_sku';
 if body.is_accessory or body.cost_amount<>5000 or body.marketplace<>'ヤフオク'
  or not accessory.is_accessory or accessory.parent_item_id is distinct from body.id
  or accessory.marketplace<>'Amazon返品' or accessory.cost_amount<>0 or accessory.lot_seq<>body.lot_seq
  or accessory.status<>body.status then raise exception 'Main/spare identity, cost or state was lost'; end if;
 if not exists(select 1 from app.spare_accessories where id=spare and used_for_item_id=body.id)
 then raise exception 'Spare allocation was not persisted'; end if;
 -- An explicit parent remains unambiguous even with another generation under the same number.
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel)
 values('899991b-AAHH-20261016-0',899991,'other generation',0,'動作品Amazon返品','2026-10-16',buyer,worker,'FBA') returning * into other;
 insert into app.items(parent_item_id,lot_seq,is_accessory,work_stream,title,cost_amount,marketplace,purchaser_id,deliverer_id,purchased_at)
 values(body.id,body.lot_seq,true,'付属品','second return spare',0,'Amazon返品',buyer,worker,'2026-05-31') returning * into accessory;
 if accessory.parent_item_id is distinct from body.id then raise exception 'Explicit parent was replaced by another generation';end if;
 begin
  insert into app.items(parent_item_id,lot_seq,is_accessory,work_stream,title,cost_amount,marketplace,purchaser_id,deliverer_id,purchased_at)
  values(body.id,899992,true,'付属品','wrong lot spare',0,'Amazon返品',buyer,worker,'2026-05-31');
 exception when sqlstate '22023' then rejected:=true;end;
 if not rejected then raise exception 'A parent from a different number was accepted';end if;
end $test$;
rollback;
