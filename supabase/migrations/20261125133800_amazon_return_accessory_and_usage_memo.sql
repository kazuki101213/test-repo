-- 2026-11-25 ユーザー指示
-- 1) 在庫（Amazon返品扱い）から取った付属品は届く荷物がないため、追跡番号がなくても本体を受取前で止めない。
-- 2) 予備の利用記録を付属品の「仕入担当者からのコメント」に入れるときは「利用記録:〜」と書く。既存の行も直す。

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
 -- Accessories taken from stock (Amazon返品) have nothing to receive.
 -- Once tracking exists, they continue to inherit the parent item's state.
 if new.is_accessory and new.parent_item_id is not null
    and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   if nullif(btrim(new.tracking_no),'') is null and new.untracked_shipping_method is null
      and not coalesce(new.marketplace in ('Amazon返品','動作品Amazon返品'),false)
      and new.status<>'販売済' then
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
       and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
       and not coalesce(a.marketplace in ('Amazon返品','動作品Amazon返品'),false)
       and a.sold_on is null and a.returned_on is null
   ) into missing_accessory_tracking;
   -- Already listed items keep their listing; only unlisted parents are held.
   if missing_accessory_tracking
      and not (tg_op='UPDATE' and old.product_registered_at is not null and new.product_registered_at is not null) then
     new.status:='受取前';return new;
   end if;
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
   elsif new.status='受取前' and pg_trigger_depth()=1 then
     new.inspected_at:=null;new.product_registered_at:=null;return new;
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
 elsif nullif(btrim(new.tracking_no),'') is not null
   and not (tg_op='UPDATE' and pg_trigger_depth()=1 and old.status='受取前'
     and new.tracking_no is not distinct from old.tracking_no) then new.status:='検品中';
 else new.status:='受取前';end if;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION app.hold_parent_until_linked_accessories_tracked()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
begin
 if tg_op='UPDATE' and old.parent_item_id is not null
    and old.parent_item_id is distinct from new.parent_item_id then
   update app.items p set status='受取前'
   where p.id=old.parent_item_id and not p.is_accessory
     and p.status in ('検品中','商品登録前','出品中')
     and p.sold_on is null and p.returned_on is null
     and p.product_registered_at is null
     and exists (
       select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
         and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
         and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
         and not coalesce(a.marketplace in ('Amazon返品','動作品Amazon返品'),false)
         and a.sold_on is null and a.returned_on is null
     );
 end if;

 if new.is_accessory and new.parent_item_id is not null
    and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   if nullif(btrim(new.tracking_no),'') is null and new.untracked_shipping_method is null
      and not coalesce(new.marketplace in ('Amazon返品','動作品Amazon返品'),false) then
     update app.items p set status='受取前'
     where p.id=new.parent_item_id and not p.is_accessory
       and p.status in ('検品中','商品登録前','出品中')
       and p.sold_on is null and p.returned_on is null
       and p.product_registered_at is null;
   elsif not exists (
       select 1 from app.items a where a.parent_item_id=new.parent_item_id and a.is_accessory and a.id<>new.id
         and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
         and nullif(btrim(a.tracking_no),'') is null and a.untracked_shipping_method is null
         and not coalesce(a.marketplace in ('Amazon返品','動作品Amazon返品'),false)
         and a.sold_on is null and a.returned_on is null) then
     update app.items p set tracking_no=p.tracking_no
     where p.id=new.parent_item_id and not p.is_accessory and p.status='受取前'
       and p.sold_on is null and p.returned_on is null
       and (nullif(btrim(p.tracking_no),'') is not null or p.untracked_shipping_method is not null);
   end if;
 end if;
 return new;
end $function$;

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
      v_spare_marketplace,v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.product_id,v_item.sales_channel,
      case when nullif(btrim(v_spare.usage_note),'') is null then null else '利用記録:'||btrim(v_spare.usage_note) end,
      v_spare.purchase_account_id)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$function$;

-- 既存の付属品コメントに「利用記録:〜」を書く。
with usage as (
  select a.id, string_agg(btrim(s.usage_note),' / ' order by s.created_at) note
  from app.spare_accessories s
  join app.items u on u.id=s.used_for_item_id
  join app.items a on a.is_accessory and (a.parent_item_id=u.id or (u.is_accessory and a.id=u.id))
  where nullif(btrim(s.usage_note),'') is not null
  group by a.id
)
update app.items a set memo = case
    when nullif(btrim(a.memo),'') is null or btrim(a.memo)=usage.note then '利用記録:'||usage.note
    when position('利用記録'||usage.note in a.memo)>0 then replace(a.memo,'利用記録'||usage.note,'利用記録:'||usage.note)
    else a.memo||E'\n'||'利用記録:'||usage.note end
from usage
where a.id=usage.id and position('利用記録:'||usage.note in coalesce(a.memo,''))=0;

-- Amazon返品の付属品のせいで止まっていた本体と付属品の状態を計算し直す。
update app.items p set status=p.status
where not p.is_accessory and p.status='受取前' and p.sold_on is null and p.returned_on is null
  and exists (select 1 from app.items a where a.parent_item_id=p.id and a.is_accessory
    and a.marketplace in ('Amazon返品','動作品Amazon返品') and nullif(btrim(a.tracking_no),'') is null);
update app.items a set status=a.status
where a.is_accessory and a.parent_item_id is not null and a.status='受取前'
  and a.marketplace in ('Amazon返品','動作品Amazon返品') and nullif(btrim(a.tracking_no),'') is null
  and a.sold_on is null and a.returned_on is null;
