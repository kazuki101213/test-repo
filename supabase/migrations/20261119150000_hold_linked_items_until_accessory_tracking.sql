CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app'
AS $function$
declare
 explicit_change boolean:=false;
 parent_status app.item_status;
 missing_accessory_tracking boolean:=false;
begin
 if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.cost_amount:=0;end if;

 -- Terminal states always take precedence over receipt tracking.
 if new.sold_on is not null then new.status:='販売済';return new;end if;
 if new.status='返品処理' or new.returned_on is not null then new.status:='返品処理';return new;end if;

 -- Linked accessories stay at 受取前 until their own tracking is recorded.
 -- Once tracking exists, they continue to inherit the parent item's state.
 if new.is_accessory and new.parent_item_id is not null
    and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   if nullif(btrim(new.tracking_no),'') is null and new.status<>'販売済' then
     new.status:='受取前';return new;
   end if;
   select status into parent_status from app.items where id=new.parent_item_id;
   if found and new.status<>'販売済' then new.status:=parent_status;return new;end if;
 end if;

 -- A parent item cannot leave 受取前 while a linked accessory has no tracking.
 if not new.is_accessory
    and new.status in ('受取前','検品中','商品登録前','出品中')
    and new.status<>'販売済' then
   select exists (
     select 1 from app.items a
     where a.parent_item_id=new.id and a.is_accessory
       and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
       and nullif(btrim(a.tracking_no),'') is null
       and a.sold_on is null and a.returned_on is null
   ) into missing_accessory_tracking;
   if missing_accessory_tracking then new.status:='受取前';return new;end if;
 end if;

 if tg_op='UPDATE' then explicit_change:=new.status is distinct from old.status;end if;
 if explicit_change then
   if new.marketplace_status_observed_at is not distinct from old.marketplace_status_observed_at then new.marketplace_status_observed_at:=now();end if;
   if new.status='販売済' then
     new.sold_on:=(now() at time zone 'Asia/Tokyo')::date;
     new.sold_price:=0;new.payout_amount:=0;return new;
   elsif new.status='Amazon返送依頼' then new.return_request_completed_at:=null;return new;
   elsif new.status='検品中' then
     if new.marketplace not in ('Amazon返品','動作品Amazon返品') and nullif(btrim(new.tracking_no),'') is null then raise exception '検品中にするには追跡番号を登録してください' using errcode='22023';end if;
     if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.return_request_completed_at:=coalesce(new.return_request_completed_at,now());end if;
     new.inspected_at:=null;new.product_registered_at:=null;
     return new;
   elsif new.status='商品登録前' then
     new.product_registered_at:=null;new.inspected_at:=coalesce(new.inspected_at,now());
     new.malfunction_resolved_at:=case when new.malfunction_reported then coalesce(new.malfunction_resolved_at,now()) else new.malfunction_resolved_at end;
     return new;
   elsif new.status='出品停止' then raise exception 'この販売状態は廃止されました。在庫を再読み込みしてください。' using errcode='22023'; elsif new.status='出品中' then
     new.product_registered_at:=coalesce(new.product_registered_at,now());return new;
   elsif new.status='動作不良' then new.malfunction_reported:=true;new.malfunction_resolved_at:=null;return new;
   elsif new.status in ('取引中','Amazon補填申請中') then return new;
 end if;
 end if;
 -- These stages require a business decision, not a shipping/photo timestamp.
 if tg_op='UPDATE' and new.sales_channel is not distinct from old.sales_channel
 and new.status in ('取引中','Amazon補填申請中')
 and new.malfunction_reported is not distinct from old.malfunction_reported then return new;end if;
 if tg_op='UPDATE' and not explicit_change and new.status='出品中'
 and new.product_registered_at is not distinct from old.product_registered_at
 and new.sales_channel is not distinct from old.sales_channel
 and not coalesce(new.malfunction_reported and new.malfunction_resolved_at is null,false) then return new;end if;
 if new.malfunction_reported and new.malfunction_resolved_at is null then new.status:='動作不良';
 elsif new.product_registered_at is not null then new.status:='出品中';
 elsif new.inspected_at is not null or (new.malfunction_resolved_at is not null and new.sales_channel='ヤフオク') then new.status:='商品登録前';
 elsif new.marketplace in ('Amazon返品','動作品Amazon返品') then
   new.status:=case when new.return_request_completed_at is not null then '検品中'::app.item_status else 'Amazon返送依頼'::app.item_status end;
 elsif nullif(btrim(new.tracking_no),'') is not null then new.status:='検品中';
 else new.status:='受取前';end if;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION app.hold_parent_until_linked_accessories_tracked()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
declare
 target_parent uuid;
begin
 if tg_op='UPDATE' and old.parent_item_id is not null
    and old.parent_item_id is distinct from new.parent_item_id then
   target_parent:=old.parent_item_id;
   update app.items p set status='受取前'
   where p.id=target_parent and not p.is_accessory
     and p.status in ('検品中','商品登録前','出品中')
     and p.sold_on is null and p.returned_on is null
     and exists (
       select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
         and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
         and nullif(btrim(a.tracking_no),'') is null
         and a.sold_on is null and a.returned_on is null
     );
 end if;

 if new.is_accessory and new.parent_item_id is not null
    and not app.is_standalone_accessory_serial(new.sku,new.lot_seq)
    and nullif(btrim(new.tracking_no),'') is null then
   update app.items p set status='受取前'
   where p.id=new.parent_item_id and not p.is_accessory
     and p.status in ('検品中','商品登録前','出品中')
     and p.sold_on is null and p.returned_on is null;
 end if;
 return new;
end $function$;

DROP TRIGGER IF EXISTS items_hold_parent_until_linked_accessories_tracked ON app.items;
CREATE TRIGGER items_hold_parent_until_linked_accessories_tracked
 AFTER INSERT OR UPDATE OF parent_item_id,is_accessory,tracking_no,sku,lot_seq ON app.items
 FOR EACH ROW EXECUTE FUNCTION app.hold_parent_until_linked_accessories_tracked();

-- Put existing active parent/accessory groups with missing accessory tracking at 受取前.
UPDATE app.items p SET status='受取前'
WHERE NOT p.is_accessory
  AND p.status IN ('検品中','商品登録前','出品中')
  AND p.sold_on IS NULL AND p.returned_on IS NULL
  AND EXISTS (
    SELECT 1 FROM app.items a WHERE a.parent_item_id=p.id AND a.is_accessory
      AND NOT app.is_standalone_accessory_serial(a.sku,a.lot_seq)
      AND NULLIF(BTRIM(a.tracking_no),'') IS NULL
      AND a.sold_on IS NULL AND a.returned_on IS NULL
  );

UPDATE app.items a SET status='受取前'
WHERE a.is_accessory AND a.parent_item_id IS NOT NULL
  AND NOT app.is_standalone_accessory_serial(a.sku,a.lot_seq)
  AND NULLIF(BTRIM(a.tracking_no),'') IS NULL
  AND a.sold_on IS NULL AND a.returned_on IS NULL
  AND a.status IS DISTINCT FROM '受取前';
