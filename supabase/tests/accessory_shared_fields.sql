-- Exercise real registration and both existing update directions, while
-- ensuring a separate purchase keeps its own order/tracking/cost.
begin;
do $$
declare buyer uuid;worker uuid;body app.items;child app.items;standalone app.items;before_parent jsonb;n integer:=994851;
begin
 select id into strict buyer from app.staff where code='AA';
 select id into strict worker from app.staff where code='DD';
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no,condition,shipped_on,sold_on)
 values(n,buyer,worker,'2026-10-01','shared-field body',9000,'ヤフオク','body-purchase-tracking','やや傷や汚れあり','2026-10-15','2026-10-16') returning * into body;
 before_parent:=to_jsonb(body);
 insert into app.items(lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,marketplace_item_id,tracking_no,condition,shipped_on,sold_on)
 values(n,body.id,true,buyer,worker,'2026-10-05','separately purchased remote',600,'メルカリ','remote-order','remote-purchase-tracking','目立った傷や汚れなし',null,null) returning * into child;
 if (child.condition,child.shipped_on,child.sold_on) is distinct from (body.condition,body.shipped_on,body.sold_on)
 then raise exception 'Late accessory did not inherit all three body fields';end if;
 if (select to_jsonb(i) from app.items i where id=body.id) is distinct from before_parent
 then raise exception 'Accessory registration changed its body';end if;
 if child.marketplace<>'メルカリ' or child.marketplace_item_id<>'remote-order' or child.tracking_no<>'remote-purchase-tracking'
  or child.purchased_at::date<>'2026-10-05'::date or child.cost_amount<>600
 then raise exception 'Accessory purchase identity overwritten';end if;
 -- Existing parent updates and clearing a mistaken date remain shared.
 update app.items set condition='目立った傷や汚れなし',shipped_on='2026-10-17',sold_on='2026-10-18' where id=body.id;
 select * into body from app.items where id=body.id;
 select * into child from app.items where id=child.id;
 if (child.condition,child.shipped_on,child.sold_on) is distinct from (body.condition,body.shipped_on,body.sold_on)
 then raise exception 'Parent correction did not synchronize';end if;
 update app.items set shipped_on=null,sold_on=null where id=body.id;
 if exists(select 1 from app.items where id=child.id and (shipped_on is not null or sold_on is not null))
 then raise exception 'Cleared dates were not shared';end if;
 update app.items set condition='傷や汚れあり',shipped_on='2026-10-19',sold_on='2026-10-20' where id=child.id;
 select * into body from app.items where id=body.id;
 select * into child from app.items where id=child.id;
 if (child.condition,child.shipped_on,child.sold_on) is distinct from (body.condition,body.shipped_on,body.sold_on)
 then raise exception 'Accessory correction did not synchronize';end if;
 if child.tracking_no<>'remote-purchase-tracking' or body.tracking_no<>'body-purchase-tracking'
 then raise exception 'Shared updates merged different purchase tracking';end if;
 -- Implicit linkage also inherits, including NULL values.
 update app.items set condition=null,shipped_on=null,sold_on=null where id=body.id;
 insert into app.items(lot_seq,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,condition)
 values(n,true,buyer,worker,'2026-10-06','implicit remote',700,'メルカリ','傷や汚れあり') returning * into child;
 if child.parent_item_id is distinct from body.id or child.condition is not null or child.shipped_on is not null or child.sold_on is not null
 then raise exception 'Implicit parent link did not inherit empty fields';end if;
 -- Standalone c-series items retain their own condition and dates.
 insert into app.items(sku,lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,condition,shipped_on,sold_on)
 values(n||'c-AADD-20261006-80',n,body.id,true,buyer,worker,'2026-10-06','standalone remote',800,'メルカリ','傷や汚れあり','2026-10-21','2026-10-22') returning * into standalone;
 if standalone.condition<>'傷や汚れあり' or standalone.shipped_on<>'2026-10-21'::date or standalone.sold_on<>'2026-10-22'::date
 then raise exception 'Standalone accessory was overwritten';end if;
 if has_function_privilege('anon','app.inherit_accessory_shared_fields_on_insert()','execute')
 or has_function_privilege('authenticated','app.inherit_accessory_shared_fields_on_insert()','execute')
 then raise exception 'Internal trigger exposed';end if;
end $$;
rollback;
