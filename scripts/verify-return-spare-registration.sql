begin;
do $$ declare aa uuid; ii uuid; ua uuid; lot integer; payload jsonb; result jsonb; body app.items; accessory app.items; spare uuid; before_spare jsonb;
begin
 select id into aa from app.staff where code='AA'; select id into ii from app.staff where code='II'; select user_id into ua from app.profiles where staff_id=aa; select max(seq)+2000 into lot from app.lots;
 select to_jsonb(s) into before_spare from app.spare_accessories s where id='9d4dc35b-f463-42a0-a571-0358ad69ea30';
 payload:=jsonb_build_object('lot_seq',lot,'purchaser_id',aa,'deliverer_id',ii,'work_stream','ブルーレイ','purchased_at','2026-10-07','title','2B-C20DT1','cost_amount',24409,'marketplace','ヤフオク','marketplace_item_id','e1246378380','asin','B08WHCZH9V','sales_channel','FBA');
 perform set_config('request.jwt.claim.sub',ua::text,true); set local role authenticated;
 result:=app.register_item_with_spare(payload,'9d4dc35b-f463-42a0-a571-0358ad69ea30');
 select * into strict body from app.items where id=(result->>'id')::uuid;
 select * into strict accessory from app.items where sku=result->>'accessory_sku';
 if body.is_accessory or body.title<>'2B-C20DT1' or body.cost_amount<>24409 or body.marketplace_item_id<>'e1246378380' or not accessory.is_accessory or accessory.marketplace<>'Amazon返品' or accessory.title<>'リモコン' or accessory.asin<>'B08WHCZH9V' or accessory.cost_amount<>0 or accessory.lot_seq<>body.lot_seq then raise exception 'Source identity or accessory lost'; end if;
 begin perform app.register_item_with_spare(payload || jsonb_build_object('lot_seq',lot+1),'9d4dc35b-f463-42a0-a571-0358ad69ea30'); raise exception 'Spare reused'; exception when sqlstate '22023' then null; end;
 reset role;
 if (select to_jsonb(s)-'used_for_item_id'-'updated_at' from app.spare_accessories s where id='9d4dc35b-f463-42a0-a571-0358ad69ea30') <> before_spare-'used_for_item_id'-'updated_at' then raise exception 'Spare source modified'; end if;
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id) values(ii,'検証返品リモコン',100,'2026-09-21','Amazon返品','test-return-spare') returning id into spare;
 set local role authenticated;
 result:=app.register_item_with_spare(payload || jsonb_build_object('lot_seq',lot+2,'deliverer_id',aa),spare);
 select * into strict body from app.items where id=(result->>'id')::uuid;
 select * into strict accessory from app.items where sku=result->>'accessory_sku';
 if not exists(select 1 from app.spare_shipping_tasks where spare_id=spare and item_id=body.id and accessory_item_id=accessory.id and owner_staff_id=ii and recipient_staff_id=aa) then raise exception 'Shipping link lost'; end if;
 -- An unrelated Amazon return labelled accessory must still become a main return.
 insert into app.items(lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,title,cost_amount,marketplace) values(lot+3,true,aa,ii,'付属品','unallocated return',500,'Amazon返品') returning * into accessory;
 if accessory.is_accessory or accessory.sku !~ '^[0-9]+a-' then raise exception 'Ordinary return behavior changed'; end if;
end $$;
select 'Real source registration, preserved body/accessory, duplicate rejection, return shipping and ordinary return passed; all rolled back' as result;
rollback;
