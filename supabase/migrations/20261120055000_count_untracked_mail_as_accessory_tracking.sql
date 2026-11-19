-- 付属品が追跡番号なし郵便（定形外・普通郵便）として記録済みなら、追跡番号ありと同じに扱う。
-- items_sync_status の保持判定が tracking_no だけを見ていたため、2476・2487が受取前に残った（2026-11-20）。
do $migration$
declare
  source text := pg_get_functiondef('app.items_sync_status()'::regprocedure);
  old_acc text := $o$if nullif(btrim(new.tracking_no),'') is null and new.status<>'販売済' then$o$;
  new_acc text := $n$if nullif(btrim(new.tracking_no),'') is null and new.untracked_shipping_method is null and new.status<>'販売済' then$n$;
  old_par text := $o$       and nullif(btrim(a.tracking_no),'') is null
       and a.sold_on is null and a.returned_on is null
   ) into missing_accessory_tracking;$o$;
  new_par text := $n$       and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
       and a.sold_on is null and a.returned_on is null
   ) into missing_accessory_tracking;$n$;
begin
  if strpos(source, old_acc) = 0 or strpos(source, old_par) = 0 then
    raise exception 'Expected accessory tracking checks not found';
  end if;
  source := replace(source, old_acc, new_acc);
  source := replace(source, old_par, new_par);
  execute source;
end;
$migration$;

update app.items p set tracking_no=p.tracking_no
where not p.is_accessory and p.status='受取前' and p.sold_on is null and p.returned_on is null
  and (nullif(btrim(p.tracking_no),'') is not null or p.untracked_shipping_method is not null)
  and exists (select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
    and not app.is_standalone_accessory_serial(a.sku,a.lot_seq))
  and not exists (select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
    and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
    and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
    and a.sold_on is null and a.returned_on is null);
