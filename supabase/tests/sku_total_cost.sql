begin;
do $test$
declare buyer uuid;worker uuid;body app.items;other_body app.items;accessory app.items;extra uuid;returned uuid;
 before_body jsonb;answer jsonb;old_sku text;actual text;zero_body app.items;zero_accessory app.items;
begin
 select id into buyer from app.staff where code='AA';
 select id into worker from app.staff where code='DD';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=buyer limit 1),true);
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values(998911,buyer,worker,'2026-10-01','SKU total-cost fixture',11509,'メルカリ','メルカリ') returning * into body;
 old_sku:=body.sku;before_body:=to_jsonb(body)-'sku'-'updated_at';
 insert into app.items(lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values(body.lot_seq,body.id,true,buyer,worker,'2026-10-02','Remote cost fixture',609,'ヤフオク','メルカリ') returning * into accessory;
 select sku into actual from app.items where id=body.id;
 if split_part(actual,'-',4)<>'1211' then raise exception 'Body cost must round after summing 11509+609: %',actual;end if;
 if split_part(accessory.sku,'-',4)<>'60' then raise exception 'Accessory must use its own cost: %',accessory.sku;end if;
 if (select to_jsonb(i)-'sku'-'updated_at' from app.items i where id=body.id) is distinct from before_body then
  raise exception 'Cost correction changed main-product business state';end if;
 if not exists(select 1 from app.item_sku_aliases where item_id=body.id and sku=old_sku) then
  raise exception 'Original external SKU was not retained';end if;
 update app.items set cost_amount=619 where id=accessory.id;
 if (select split_part(sku,'-',4) from app.items where id=body.id)<>'1212'
  or (select split_part(sku,'-',4) from app.items where id=accessory.id)<>'61' then raise exception 'Accessory cost edit was not propagated';end if;
 update app.items set cost_amount=12009 where id=body.id;
 if (select split_part(sku,'-',4) from app.items where id=body.id)<>'1262' then raise exception 'Body cost edit lost accessory cost';end if;
 insert into app.items(lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values(body.lot_seq,body.id,true,buyer,worker,'2026-10-03','Cable cost fixture',205,'ヤフオク','メルカリ') returning id into extra;
 if (select split_part(sku,'-',4) from app.items where id=body.id)<>'1283' then raise exception 'Multiple accessory costs were not summed';end if;
 update app.items set status='返品処理' where id=body.id;
 insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values('998911b-AADD-20261004-0',body.lot_seq,buyer,worker,'2026-10-04','Returned body fixture',0,'動作品Amazon返品','メルカリ') returning id into returned;
 if (select split_part(sku,'-',4) from app.items where id=returned)<>'1283' then raise exception 'Return did not inherit original body plus accessory cost';end if;
 update app.items set cost_amount=9999 where id=returned;
 if (select split_part(sku,'-',4) from app.items where id=returned)<>'1283' then raise exception 'Return accounting cost was counted twice';end if;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values(998912,buyer,worker,'2026-10-01','Other body fixture',5000,'メルカリ','メルカリ') returning * into other_body;
 select * into accessory from app.items where id=accessory.id;
 answer:=app.reassign_accessory_usage(accessory.id,'998912',accessory.updated_at);
 if (select split_part(sku,'-',4) from app.items where id=body.id)<>'1221'
  or (select split_part(sku,'-',4) from app.items where id=returned)<>'1221'
  or (select split_part(sku,'-',4) from app.items where id=other_body.id)<>'561'
  or (select split_part(sku,'-',4) from app.items where id=accessory.id)<>'61' then
  raise exception 'Usage reassignment did not update old/new families or preserve accessory cost';end if;
 delete from app.items where id=extra;
 if (select split_part(sku,'-',4) from app.items where id=body.id)<>'1200' then raise exception 'Accessory deletion did not subtract cost';end if;
 if (select split_part(sku,'-',4) from app.items where id=returned)<>'1200' then raise exception 'Return was not refreshed after accessory deletion';end if;
 delete from app.items where id=accessory.id;
 if (select split_part(sku,'-',4) from app.items where id=other_body.id)<>'500' then raise exception 'Other family did not remove accessory cost';end if;
 insert into app.items(sku,lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values('998911c-AADD-20261005-123',998911,body.id,true,buyer,worker,'2026-10-05','Standalone accessory fixture',1234,'ヤフオク','メルカリ');
 if (select split_part(sku,'-',4) from app.items where id=body.id)<>'1200' then raise exception 'Standalone accessory was added to another sale';end if;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values(998913,buyer,worker,'2026-10-01','Zero cost body',0,'メルカリ','メルカリ') returning * into zero_body;
 insert into app.items(sku,lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel)
 values('998913-AADD-20261001-60',998913,zero_body.id,true,buyer,worker,'2026-10-01','Same prefix accessory',600,'ヤフオク','メルカリ') returning * into zero_accessory;
 if (select sku from app.items where id=zero_body.id)<>'998913-AADD-20261001-60'
  or zero_accessory.sku<>'998913a-AADD-20261001-60' then raise exception 'New accessory stole its body total-cost SKU';end if;
 -- A live/historical SKU belonging to another item must not be reassigned.
 insert into app.item_sku_aliases(sku,item_id) values('998913-AADD-20261001-160',zero_accessory.id);
 update app.items set cost_amount=1000 where id=zero_body.id;
 if (select sku from app.items where id=zero_body.id)<>'998913-AADD-20261001-60' then raise exception 'Reserved historical SKU switched owners';end if;
 if has_function_privilege('authenticated','app.sku_with_total_cost(app.items)','execute')
  or has_function_privilege('anon','app.sku_with_total_cost(app.items)','execute') then raise exception 'Internal cost lookup was exposed';end if;
end $test$;
rollback;
