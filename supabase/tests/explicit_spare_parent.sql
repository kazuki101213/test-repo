begin;
do $test$
declare buyer uuid; worker uuid; spare uuid; result jsonb; body app.items; accessory app.items; other app.items; rejected boolean:=false; main_product uuid; remote_product uuid; image text;
begin
 select id into buyer from app.staff where code='AA';
 select id into worker from app.staff where code='HH';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.products(product_no,asin,model_no,maker,image_url)
 values(899991,'B00BODY991','BDZ-ZW550','SONY','https://example.com/body.jpg') returning id into main_product;
 insert into app.products(product_no,asin,model_no,maker,image_url)
 values(899992,'B00RMT0991','RMT-TEST','SONY','https://example.com/remote.jpg') returning id into remote_product;
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace,marketplace_item_id,manufacturer)
 values(buyer,'リモコン',0,'2026-05-30','Amazon返品','explicit-spare-test','SONY') returning id into spare;
 -- The actual RPC creates the new Yahoo main item, allocates the spare, then inserts its accessory.
 result:=app.register_item_with_spare(jsonb_build_object('lot_seq',899991,'purchaser_id',buyer,'deliverer_id',worker,
  'work_stream','ブルーレイ','purchased_at','2026-10-16','title','BDZ-ZW550','cost_amount',5000,
  'marketplace','ヤフオク','marketplace_item_id','explicit-body-test','sales_channel','FBA','product_id',main_product),spare);
 select * into strict body from app.items where id=(result->>'id')::uuid;
 select * into strict accessory from app.items where sku=result->>'accessory_sku';
 if body.is_accessory or body.cost_amount<>5000 or body.marketplace<>'ヤフオク'
  or not accessory.is_accessory or accessory.parent_item_id is distinct from body.id
  or accessory.marketplace<>'Amazon返品' or accessory.cost_amount<>0 or accessory.lot_seq<>body.lot_seq
  or accessory.status<>body.status then raise exception 'Main/spare identity, cost or state was lost'; end if;
 if not exists(select 1 from app.spare_accessories where id=spare and used_for_item_id=body.id)
 then raise exception 'Spare allocation was not persisted'; end if;
 select amazon_image_url into image from app.v_inventory_display where id=body.id;
 if image is distinct from 'https://example.com/body.jpg' then raise exception 'Main image was lost';end if;
 if exists(select 1 from app.v_inventory_display where id=accessory.id and amazon_image_url is not null)
  or exists(select 1 from app.v_delivery_tasks where id=accessory.id and reference_image_url is not null)
 then raise exception 'Accessory inherited the main image';end if;
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
 -- Use an independent family: return-generation closure deliberately synchronizes shared SKUs.
 insert into app.items(lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id,sales_channel,product_id)
 values(899993,'independent body',5000,'ヤフオク','2026-10-16',buyer,worker,'FBA',main_product) returning * into other;
 insert into app.items(parent_item_id,lot_seq,is_accessory,work_stream,title,cost_amount,marketplace,purchaser_id,deliverer_id,purchased_at,product_id)
 values(other.id,other.lot_seq,true,'付属品','own remote',100,'メルカリ',buyer,worker,'2026-05-29',remote_product) returning * into accessory;
 select amazon_image_url into image from app.v_inventory_display where id=accessory.id;
 if image is distinct from 'https://example.com/remote.jpg' then raise exception 'Own accessory image was lost';end if;
 select reference_image_url into image from app.v_delivery_tasks where id=accessory.id;
 if image is distinct from 'https://example.com/remote.jpg' then raise exception 'Own delivery accessory image was lost';end if;
 -- Attaching an Amazon-return spare to an existing aa body must not create another body.
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id)
 values('899994-AAHH-20260901-100',899994,'original',1000,'メルカリ','2026-09-01',buyer,worker),
       ('899994a-AAHH-20260902-0',899994,'first return',0,'メルカリ','2026-09-02',buyer,worker);
 insert into app.items(sku,lot_seq,title,cost_amount,marketplace,purchased_at,purchaser_id,deliverer_id)
 values('899994aa-AAHH-20260903-0',899994,'target aa body',0,'メルカリ','2026-09-03',buyer,worker) returning * into body;
 insert into app.spare_accessories(owner_staff_id,title,cost_amount,purchased_at,marketplace)
 values(buyer,'リモコン',0,'2026-09-22','Amazon返品') returning id into spare;
 result:=app.register_item_with_spare(jsonb_build_object('sku','899994aa-AAHH-20260922-0','lot_seq',899994,'is_accessory',true,
  'purchaser_id',buyer,'deliverer_id',worker,'work_stream','付属品','purchased_at','2026-09-22','title','リモコン',
  'cost_amount',0,'marketplace','Amazon返品','sales_channel','メルカリ'),spare);
 select * into strict accessory from app.items where id=(result->>'id')::uuid;
 if not accessory.is_accessory or accessory.parent_item_id is distinct from body.id then raise exception 'Amazon-return spare did not attach to the exact aa body';end if;
 if accessory.sku !~ '^899994aa[a-z]+-' then raise exception 'Return accessory SKU lost its lowercase aa parent serial';end if;
 if (select count(*) from app.items where lot_seq=899994 and not is_accessory)<>3 then raise exception 'Accessory registration created a new returned body';end if;
 if not exists(select 1 from app.spare_accessories where id=spare and used_for_item_id=accessory.id) then raise exception 'Selected reserve was not allocated to the accessory';end if;
end $test$;
rollback;
