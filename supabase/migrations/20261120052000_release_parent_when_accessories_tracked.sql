-- 付属品に追跡番号が無い間は本体を受取前に留める（2026-11-19の保持ルール）。
-- ただし、紐づく付属品がすべて追跡番号あり、または追跡番号なし郵便（定形外・普通郵便）として記録済みになったら、
-- 本体を通常の状態判定（追跡番号あり→検品中など）へ自動で戻す。2470が番号入力後も受取前に残った（2026-11-20）。
create or replace function app.hold_parent_until_linked_accessories_tracked()
returns trigger language plpgsql security definer set search_path to 'pg_catalog', 'app' as $function$
begin
 if tg_op='UPDATE' and old.parent_item_id is not null
    and old.parent_item_id is distinct from new.parent_item_id then
   update app.items p set status='受取前'
   where p.id=old.parent_item_id and not p.is_accessory
     and p.status in ('検品中','商品登録前','出品中')
     and p.sold_on is null and p.returned_on is null
     and exists (
       select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
         and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
         and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
         and a.sold_on is null and a.returned_on is null
     );
 end if;

 if new.is_accessory and new.parent_item_id is not null
    and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   if nullif(btrim(new.tracking_no),'') is null and new.untracked_shipping_method is null then
     update app.items p set status='受取前'
     where p.id=new.parent_item_id and not p.is_accessory
       and p.status in ('検品中','商品登録前','出品中')
       and p.sold_on is null and p.returned_on is null;
   elsif not exists (
       select 1 from app.items a where a.parent_item_id=new.parent_item_id and a.is_accessory and a.id<>new.id
         and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
         and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
         and a.sold_on is null and a.returned_on is null) then
     -- Re-run the normal status calculation on the parent (tracking_no → 検品中, etc.).
     update app.items p set tracking_no=p.tracking_no
     where p.id=new.parent_item_id and not p.is_accessory and p.status='受取前'
       and p.sold_on is null and p.returned_on is null
       and (nullif(btrim(p.tracking_no),'') is not null or p.untracked_shipping_method is not null);
   end if;
 end if;
 return new;
end $function$;

drop trigger if exists items_hold_parent_until_linked_accessories_tracked on app.items;
create trigger items_hold_parent_until_linked_accessories_tracked
after insert or update of parent_item_id, is_accessory, tracking_no, untracked_shipping_method, sku, lot_seq on app.items
for each row execute function app.hold_parent_until_linked_accessories_tracked();

-- 既存の保持中のうち、付属品がすべて揃っている本体を通常判定へ戻す。
update app.items p set tracking_no=p.tracking_no
where not p.is_accessory and p.status='受取前' and p.sold_on is null and p.returned_on is null
  and (nullif(btrim(p.tracking_no),'') is not null or p.untracked_shipping_method is not null)
  and exists (select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
    and not app.is_standalone_accessory_serial(a.sku,a.lot_seq))
  and not exists (select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
    and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
    and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
    and a.sold_on is null and a.returned_on is null);
