CREATE OR REPLACE FUNCTION app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
  v_spare_marketplace app.marketplace;
  v_parent_id uuid;
  v_parent_count integer;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text,179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_spare_marketplace := case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
    then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) then
    select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
      from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq
        and app.product_serial(p.sku,p.lot_seq)=app.product_serial(v_input.sku,v_input.lot_seq);
    if v_parent_count=0 then
      select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
        from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq;
    end if;
    if v_parent_count<>1 then
      raise exception 'この通番号の本体を一意に特定できません。本体を先に登録してください' using errcode='22023';
    end if;
    v_input.parent_item_id := v_parent_id;

    -- The selected spare supplies its original purchase data, even if an open form still contains other values.
    if v_input.marketplace is distinct from v_spare_marketplace
      or v_input.marketplace_item_id is distinct from v_spare.marketplace_item_id then
      v_input.marketplace_url := null;
      v_input.tracking_no := null;
    end if;
    v_input.marketplace := v_spare_marketplace;
    v_input.marketplace_item_id := v_spare.marketplace_item_id;
    v_input.purchase_account_id := v_spare.purchase_account_id;
    v_input.title := v_spare.title;
    v_input.purchased_at := coalesce(v_spare.purchased_at,v_input.purchased_at);
    v_input.cost_amount := v_spare.cost_amount;
    v_input.tracking_no := coalesce(v_spare.tracking_no,v_input.tracking_no);

    if v_input.sku is not null and v_input.purchaser_id is distinct from v_spare.purchaser_id then
      v_input.sku := regexp_replace(v_input.sku, '^([0-9]+[a-z]*-)[a-z]{2,4}(-)',
        '\1' || (select code from app.staff where id = v_spare.purchaser_id)
             || coalesce((select code from app.staff where id = v_input.deliverer_id), '') || '\2', 'i');
    end if;
    v_input.purchaser_id := v_spare.purchaser_id;
  end if;
  insert into app.items (parent_item_id,sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id,sales_account_id,purchase_account_id)
  values (v_input.parent_item_id,v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'受取前'::app.item_status),v_input.memo,v_input.source_purchase_draft_id,v_input.sales_account_id,v_input.purchase_account_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (parent_item_id,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,product_id,sales_channel,memo,purchase_account_id)
    values (v_item.id,v_item.lot_seq,true,v_spare.purchaser_id,v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      v_spare_marketplace,v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.product_id,v_item.sales_channel,v_spare.usage_note,v_spare.purchase_account_id)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$function$;
