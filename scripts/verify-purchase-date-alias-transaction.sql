begin;
do $$
declare i app.items; r app.items; alias_item uuid; u uuid;
begin
  select * into strict i from app.items where sku='1270a-EE-18991230-0';
  select item_id into strict alias_item from app.item_sku_aliases where sku='1270a-EE-20260921-0';
  select p.user_id into strict u from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA';
  perform set_config('request.jwt.claim.sub',u::text,true);
  set local role authenticated;
  update app.items set purchased_at=null where id=i.id;
  update app.items set purchased_at='2026-09-21' where id=i.id;
  select * into strict r from app.items where id=i.id;
  if r.purchased_at<>'2026-09-21' or r.sku<>i.sku then raise exception 'Date-only alias fallback failed'; end if;
  update app.items set purchased_at=purchased_at where id=i.id;
  if (select sku from app.items where id=i.id)<>i.sku then raise exception 'Repeated save changed identity'; end if;
  -- Explicit takeover of another item's alias is still rejected.
  begin
    update app.items set sku='1270a-EE-20260921-0' where id=i.id;
    raise exception 'Explicit alias takeover allowed';
  exception when unique_violation then null; end;
  -- A non-colliding date still regenerates SKU as before.
  update app.items set purchased_at='2026-09-20' where id=i.id;
  if (select sku from app.items where id=i.id)<>'1270a-EE-20260920-0' then raise exception 'Normal regeneration changed'; end if;
  reset role;
  if (select item_id from app.item_sku_aliases where sku='1270a-EE-20260921-0')<>alias_item then
    raise exception 'Other item alias changed'; end if;
end $$;
select 'Date fallback, repeat save, explicit collision rejection and ordinary regeneration passed' as result;
rollback;
