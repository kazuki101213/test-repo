-- AA administrator may ship on behalf of the holder; all fixed-link and retry checks remain.
create or replace function app.send_spare_shipping(p_task_id uuid,p_tracking_no text)
returns void language plpgsql security definer set search_path='' as $$
declare t app.spare_shipping_tasks; tracking text:=nullif(btrim(p_tracking_no),'');
begin
  if auth.uid() is null or app.current_role() is null then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  select * into t from app.spare_shipping_tasks where id=p_task_id for update;
  if t.id is null or (t.owner_staff_id is distinct from app.current_staff_id()
    and not (coalesce(app.is_admin(), false) and exists(
      select 1 from app.staff where id=app.current_staff_id() and code='AA' and is_active
    ))) then
    raise exception 'この発送依頼を送信する権限がありません' using errcode='42501';
  end if;
  if tracking is null or length(tracking)>200 then
    raise exception '追跡番号を1〜200文字で入力してください' using errcode='22023';
  end if;
  if t.sent_at is not null then
    if t.tracking_no=tracking then return; end if;
    raise exception 'この発送依頼は送信済みです' using errcode='22023';
  end if;
  if not exists(select 1 from app.items where id=t.item_id and deliverer_id=t.recipient_staff_id)
    or not exists(select 1 from app.spare_accessories where id=t.spare_id and used_for_item_id=t.item_id
      and owner_staff_id=t.owner_staff_id) then
    raise exception '担当者または予備の割当が変更されています。管理者に確認してください' using errcode='22023';
  end if;
  update app.items set tracking_no=tracking where id=t.accessory_item_id
    and is_accessory and lot_seq=t.lot_seq and deliverer_id=t.recipient_staff_id;
  if not found then raise exception '発送先の付属品が変更されています' using errcode='22023'; end if;
  update app.spare_shipping_tasks set tracking_no=tracking,sent_at=now() where id=t.id;
end $$;
revoke all on function app.send_spare_shipping(uuid,text) from public,anon;
grant execute on function app.send_spare_shipping(uuid,text) to authenticated;

