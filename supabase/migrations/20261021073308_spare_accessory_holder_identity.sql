-- Keep the source holder separate from the buyer of a separately registered accessory.
create or replace function app.queue_spare_shipping(p_spare_id uuid,p_item_id uuid,p_accessory_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s app.spare_accessories; i app.items; a app.items; task_id uuid;
begin
  if auth.uid() is null or app.current_role() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '発送依頼を作成する権限がありません' using errcode='42501';
  end if;
  select * into s from app.spare_accessories where id=p_spare_id for update;
  select * into i from app.items where id=p_item_id;
  select * into a from app.items where id=p_accessory_id;
  if s.id is null or i.id is null or a.id is null or s.used_for_item_id is distinct from i.id
    or not a.is_accessory or a.lot_seq is distinct from i.lot_seq
    or a.deliverer_id is distinct from i.deliverer_id
    or a.title is distinct from s.title or a.marketplace_item_id is distinct from s.marketplace_item_id
    -- For an existing main item, i and a are the same newly registered accessory.
    -- Its buyer is independent of the spare holder who sends it.
    or (i.is_accessory and a.id is distinct from i.id)
    or (not i.is_accessory and a.purchaser_id is distinct from coalesce(s.owner_staff_id,i.purchaser_id))
    or (not app.is_admin() and (s.owner_staff_id is distinct from app.current_staff_id()
      or i.purchaser_id is distinct from app.current_staff_id())) then
    raise exception '予備と付属品の紐づけを確認できません' using errcode='22023';
  end if;
  if s.owner_staff_id is null or i.deliverer_id is null or s.owner_staff_id=i.deliverer_id then return null; end if;
  if not exists(select 1 from app.staff where id=s.owner_staff_id and is_active)
    or not exists(select 1 from app.staff where id=i.deliverer_id and is_active) then
    raise exception '発送元または発送先の担当者が無効です' using errcode='22023';
  end if;
  insert into app.spare_shipping_tasks(spare_id,item_id,accessory_item_id,owner_staff_id,recipient_staff_id,
    title,manufacturer,marketplace,marketplace_item_id,usage_note,lot_seq)
  values(s.id,i.id,a.id,s.owner_staff_id,i.deliverer_id,s.title,s.manufacturer,s.marketplace,
    s.marketplace_item_id,s.usage_note,i.lot_seq)
  on conflict(spare_id) do nothing returning id into task_id;
  if task_id is null then
    select id into task_id from app.spare_shipping_tasks where spare_id=s.id
      and item_id=i.id and accessory_item_id=a.id;
    if task_id is null then raise exception '既存の発送依頼と紐づけが異なります' using errcode='22023'; end if;
  end if;
  return task_id;
end $$;
