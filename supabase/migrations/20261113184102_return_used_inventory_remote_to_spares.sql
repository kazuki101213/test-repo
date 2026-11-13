CREATE OR REPLACE FUNCTION app.move_inventory_accessory_to_spares(p_item_id uuid, p_spare_input jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item app.items%rowtype;
  v_spare_id uuid;
  v_owner_id uuid;
  v_owner_name text;
  v_registered_serial text;
  v_history_item_id uuid;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備一覧へ登録する権限がありません' using errcode='42501';
  end if;
  if p_spare_input is null or jsonb_typeof(p_spare_input) <> 'object' then
    raise exception 'リモコン情報が不正です' using errcode='22023';
  end if;

  select * into v_item from app.items where id=p_item_id for update;
  if not found then raise exception '在庫一覧のリモコン行が見つかりません' using errcode='P0002'; end if;
  if not v_item.is_accessory or v_item.title not ilike '%リモコン%' then
    raise exception '対象は付属品登録されたリモコン行ではありません' using errcode='22023';
  end if;
  if app.current_role() = 'purchaser' and v_item.purchaser_id is distinct from app.current_staff_id() then
    raise exception '担当外のリモコン行は移動できません' using errcode='42501';
  end if;
  if coalesce(p_spare_input->>'usage_note','') !~ '^[0-9]+[a-z]*$' then
    raise exception '利用記録に通番号を入力してください' using errcode='22023';
  end if;
  v_registered_serial := upper(p_spare_input->>'usage_note');
  if v_registered_serial is distinct from app.product_serial(v_item.sku,v_item.lot_seq) then
    raise exception '入力した通番号と在庫行の通番号が一致しません' using errcode='22023';
  end if;

  v_owner_id := coalesce(nullif(p_spare_input->>'owner_staff_id','')::uuid, v_item.deliverer_id, v_item.purchaser_id, app.current_staff_id());
  if app.current_role() = 'purchaser' and v_owner_id is distinct from app.current_staff_id() and v_owner_id is distinct from v_item.deliverer_id then
    raise exception '保管担当者には自分または商品の納品担当者を指定してください' using errcode='42501';
  end if;
  select name into v_owner_name from app.staff where id=v_owner_id;
  v_owner_name := coalesce(nullif(btrim(p_spare_input->>'owner_name'),''),v_owner_name);
  if nullif(btrim(p_spare_input->>'title'),'') is null then
    raise exception '品名を入力してください' using errcode='22023';
  end if;
  if coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount) < 0 then
    raise exception '仕入金額は0円以上で入力してください' using errcode='22023';
  end if;

  insert into app.spare_accessories (
    source_sku,owner_staff_id,owner_name,purchased_at,title,manufacturer,model_no,asin,
    cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note,purchase_account_id
  ) values (
    coalesce(nullif(p_spare_input->>'source_sku',''),v_item.sku),
    v_owner_id,v_owner_name,
    coalesce(nullif(p_spare_input->>'purchased_at','')::date,v_item.purchased_at),
    btrim(p_spare_input->>'title'),
    nullif(btrim(p_spare_input->>'manufacturer'),''),
    nullif(btrim(p_spare_input->>'model_no'),''),
    nullif(btrim(p_spare_input->>'asin'),''),
    coalesce(nullif(p_spare_input->>'cost_amount','')::bigint,v_item.cost_amount),
    nullif(p_spare_input->>'marketplace',''),
    nullif(p_spare_input->>'marketplace_item_id',''),
    nullif(p_spare_input->>'tracking_no',''),
    p_spare_input->>'usage_note',
    case when p_spare_input ? 'purchase_account_id' then p_spare_input->>'purchase_account_id'
      when v_item.marketplace::text=p_spare_input->>'marketplace' then v_item.purchase_account_id end
  ) returning id into v_spare_id;

  -- Keep the previous spare's usage history on the current body, as Yahoo preparation does.
  -- The newly registered spare is the only available record for this transfer.
  if exists (select 1 from app.spare_accessories where used_for_item_id=v_item.id) then
    select id into v_history_item_id from app.items
    where id=v_item.parent_item_id and not is_accessory;
    if v_history_item_id is null then
      raise exception '利用履歴の移行先となる本体が見つかりません。付属品の紐づけを確認してください。' using errcode='22023';
    end if;
    update app.spare_accessories set used_for_item_id=v_history_item_id, updated_at=now()
    where used_for_item_id=v_item.id;
  end if;
  delete from app.items where id=v_item.id;
  return v_spare_id;
end;
$function$;

notify pgrst, 'reload schema';
