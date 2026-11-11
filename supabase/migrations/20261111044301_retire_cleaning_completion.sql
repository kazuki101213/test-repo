-- Keep historical cleaning timestamps while stopping new writes and removing all workflow checks.

CREATE OR REPLACE FUNCTION app.perform_inventory_action(p_item_id uuid, p_action text, p_expected_status app.item_status, p_note text DEFAULT NULL::text, p_request_id uuid DEFAULT gen_random_uuid())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
declare i app.items;actor uuid:=app.current_staff_id();manager boolean;target app.item_status;old_event app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 manager:=coalesce(app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=actor),false);
 if i.id is null or not coalesce(manager or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から操作してください' using errcode='22023';end if;
 if p_request_id is null then raise exception '操作IDがありません' using errcode='22023';end if;
 select * into old_event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if old_event.item_id=i.id and old_event.actor_id=actor and old_event.action=p_action and old_event.note is not distinct from nullif(btrim(p_note),'') then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';
 end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('running','uncertain')) or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('running','uncertain')) then raise exception '実行中の操作の結果を確認してから状態を変更してください';end if;
 if i.sold_on is not null or i.status='販売済' then raise exception '販売済の商品は管理機能で販売日を訂正してください' using errcode='22023';end if;
 if i.status is distinct from p_expected_status then raise exception '状態が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 if length(coalesce(p_note,''))>2000 then raise exception '2000文字以内で入力してください' using errcode='22023';end if;
 target:=i.status;
 case p_action
 when 'return_request_complete' then
  if i.status<>'Amazon返送依頼' or i.marketplace not in ('Amazon返品','動作品Amazon返品') then raise exception '返送依頼待ちの商品ではありません';end if;
  target:='検品中';update app.items set return_request_completed_at=clock_timestamp(),status=target where id=i.id;
 when 'return_request_cancel' then
  if i.status<>'検品中' or i.marketplace not in ('Amazon返品','動作品Amazon返品') then raise exception '返送依頼の取消対象ではありません';end if;
  target:='Amazon返送依頼';update app.items set return_request_completed_at=null,status=target where id=i.id;
 when 'inspection_complete' then
  if i.status<>'検品中' then raise exception '検品中の商品ではありません';end if;
  target:='商品登録前';update app.items set inspected_at=coalesce(inspected_at,clock_timestamp()),status=target where id=i.id;
 when 'inspection_cancel' then
  if i.status<>'商品登録前' or i.workflow_decision is not null then raise exception '検品完了の取消対象ではありません';end if;
  target:='検品中';update app.items set inspected_at=null,product_registered_at=null,status=target where id=i.id;
 when 'report' then
  if i.status<>'検品中' or nullif(btrim(p_note),'') is null then raise exception '検品中の商品について報告内容を入力してください';end if;
  target:=case when i.marketplace in ('Amazon返品','動作品Amazon返品') then 'Amazon補填申請中'::app.item_status else '動作不良'::app.item_status end;
  update app.items set malfunction_reported=true,malfunction_comment=btrim(p_note),malfunction_reported_at=clock_timestamp(),malfunction_reported_by=actor,malfunction_resolved_at=null,malfunction_resolved_by=null,status=target where id=i.id;
 when 'report_cancel','send_back' then
  if p_action='send_back' and nullif(btrim(p_note),'') is null then raise exception '差し戻し理由を入力してください' using errcode='22023';end if;
  if i.status not in ('動作不良','Amazon補填申請中') then raise exception '報告の取消対象ではありません';end if;
  if p_action='send_back' and not manager then raise exception '管理者・仕入担当者のみ差し戻しできます' using errcode='42501';end if;
  if i.status='Amazon補填申請中' and not manager then raise exception '破損報告の差し戻しは管理側から行ってください' using errcode='42501';end if;
  target:='検品中';update app.items set malfunction_reported=false,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,supplier_contact_requested_at=null,workflow_decision=null,status=target where id=i.id;
 when 'supplier_check' then
  if not manager then raise exception '管理者・仕入担当者のみ操作できます' using errcode='42501';end if;
  if i.status<>'動作不良' then raise exception '動作不良の商品ではありません';end if;
  update app.items set supplier_contact_requested_at=clock_timestamp() where id=i.id;
  insert into app.item_comments(item_id,author_id,body,task_kind) values(i.id,actor,'仕入先へ確認します。','仕入先確認');
 when 'supplier_return_complete' then
  if i.status<>'動作不良' or i.supplier_contact_requested_at is null then raise exception '仕入先確認後に返品完了を登録してください';end if;
  target:='返品処理';update app.items set returned_on=(clock_timestamp() at time zone 'Asia/Tokyo')::date,status=target where id=i.id;
 when 'supplier_return_cancel' then
  if i.status<>'返品処理' or i.marketplace in ('Amazon返品','動作品Amazon返品') then raise exception '返品完了の取消対象ではありません';end if;
  target:='動作不良';update app.items set returned_on=null,malfunction_reported=true,malfunction_resolved_at=null,status=target where id=i.id;
 when 'return_impossible','yahoo_instruction' then
  if i.status<>'動作不良' or (p_action='return_impossible' and i.supplier_contact_requested_at is null) then raise exception '動作不良の商品で仕入先確認後に操作してください';end if;
  if p_action='yahoo_instruction' and not manager then raise exception '販売指示は管理側から行ってください' using errcode='42501';end if;
  target:='商品登録前';update app.items set workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status=target where id=i.id;
 when 'yahoo_instruction_cancel' then
  if i.status<>'商品登録前' or i.workflow_decision is distinct from 'yahoo' then raise exception '返品不可・販売指示の取消対象ではありません';end if;
  target:='動作不良';update app.items set sales_channel=coalesce(workflow_previous_sales_channel,sales_channel),workflow_decision=null,malfunction_reported=true,malfunction_resolved_at=null,status=target where id=i.id;
 when 'compensation_complete','compensation_denied' then
  if not manager then raise exception '補填結果は管理側から登録してください' using errcode='42501';end if;
  if i.status<>'Amazon補填申請中' then raise exception 'Amazon補填申請中の商品ではありません';end if;
  target:='商品登録前';update app.items set sales_channel='ヤフオク',workflow_decision=case when p_action='compensation_complete' then 'compensated' else 'compensation_denied' end,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status=target where id=i.id;
 when 'listing_complete' then
  if not exists(select 1 from app.amazon_listing_submissions s where s.request_id=p_request_id and s.item_id=i.id and s.state='verified' and s.verified_at>clock_timestamp()-interval '10 minutes' and (s.sku=i.sku or exists(select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=s.sku)) and s.asin=btrim(i.asin::text) and s.sales_channel=i.sales_channel and s.price=i.planned_price and s.item_condition=i.condition::text and s.description=coalesce(i.description,'') and s.seller_id=case when i.sales_channel::text in ('FBA2','自己発送2') then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end) then raise exception 'Amazonへの登録を確認できていません。出品画面から登録結果を確認してください' using errcode='42501';end if;
  if not app.listing_photos_approved(i.id) then raise exception '管理アプリで商品写真の承認が必要です' using errcode='42501';end if;
  if i.status<>'商品登録前' or app.sales_channel_family(i.sales_channel) not in ('FBA','自己発送') then raise exception 'FBA・自己発送の出品完了のみ手動で登録できます';end if;
  target:='出品中';update app.items set product_registered_at=clock_timestamp(),status=target where id=i.id;
 when 'listing_cancel' then
  if i.status<>'出品中' or nullif(btrim(p_note),'') is null then raise exception '実際に出品されていないことを確認してください';end if;
  target:='商品登録前';update app.items set product_registered_at=null,status=target,seller_cancelled_trade_key=coalesce(seller_trade_key,'*'),seller_cancelled_at=clock_timestamp() where id=i.id;
 when 'trade_cancel','resell' then
  if i.status<>'取引中' or nullif(btrim(p_note),'') is null then raise exception '取引中の商品について理由を入力してください';end if;
  target:=case when p_action='trade_cancel' then '出品中'::app.item_status else '商品登録前'::app.item_status end;
  update app.items set status=target,product_registered_at=case when p_action='resell' then null else product_registered_at end,seller_cancelled_trade_key=coalesce(seller_trade_key,'*'),seller_cancelled_at=clock_timestamp() where id=i.id;
 else raise exception '未対応の操作です' using errcode='22023';
 end case;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note) values(p_request_id,i.id,actor,p_action,i.status,target,nullif(btrim(p_note),''));
end $function$;

CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'app'
AS $function$
declare explicit_change boolean:=false; parent_status app.item_status;
begin
 if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.cost_amount:=0;end if;
 if new.is_accessory and new.parent_item_id is not null and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then
   select status into parent_status from app.items where id=new.parent_item_id;
   if found then new.status:=parent_status;return new;end if;
 end if;
 -- Sale dates always win, including delayed browser snapshots and photo actions.
 if new.sold_on is not null then new.status:='販売済';return new;end if;
 if new.status='返品処理' or new.returned_on is not null then new.status:='返品処理';return new;end if;
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
   elsif new.status='出品中' then
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

CREATE OR REPLACE FUNCTION app.set_delivery_progress(p_item_id uuid, p_step text, p_done boolean, p_on date DEFAULT NULL::date)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result app.items; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 -- Older clients may still use the former combined step name.
 if p_step='inspection_cleaning' then p_step:='inspection'; end if;
 if p_done is null or p_step not in ('inspection','listing','packed','shipped') then raise exception '作業項目を確認してください' using errcode='22023'; end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then raise exception '日付を入力してください' using errcode='22023'; end if;
 if p_step='listing' then return app.set_delivery_listing_progress(p_item_id,p_done); end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false) and app.photo_review_enforced() and not app.is_delivery_master()
  and not exists(select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501'; end if;
 update app.items set inspected_at=case when p_step='inspection' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 if p_step='packed' and p_done then perform app.queue_packed_shipping_code(p_item_id); end if;
 return result;
end $function$;

CREATE OR REPLACE FUNCTION app.enqueue_accessory_receipt_tasks(p_parent_id uuid, p_requested_at timestamp with time zone)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
 insert into app.receipt_evaluation_tasks(item_id,requested_at)
 select i.id,p_requested_at from app.items i join app.items parent on parent.id=i.parent_item_id
 where parent.id=p_parent_id and not parent.is_accessory and i.is_accessory and i.id<>parent.id
 and not app.receipt_item_is_spare_accessory(i)
 and parent.inspected_at is not null
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and nullif(btrim(i.marketplace_item_id),'') is not null
 and row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
   is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id)
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and d.marketplace_item_id=i.marketplace_item_id
   and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
 on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null
$function$;

CREATE OR REPLACE FUNCTION app.marketplace_extension_probe(p_marketplace app.marketplace, p_item_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare v_items jsonb;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or nullif(trim(p_item_id),'') is null or length(p_item_id)>100 then raise exception '照合条件が不正です'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'sku',sku,'marketplace',marketplace,'tracking_no',tracking_no,'inspected_at',inspected_at)), '[]'::jsonb)
    into v_items from app.items
    where marketplace_item_id=p_item_id and (marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and marketplace in ('ヤフフリ','PayPayフリマ')));
  return jsonb_build_object('items',v_items,'count',jsonb_array_length(v_items));
end $function$;

CREATE OR REPLACE FUNCTION app.marketplace_receipt_context(p_marketplace app.marketplace, p_item_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare
  v_probe jsonb;
  v_items jsonb;
  v_group_ok boolean;
  v_source_ready boolean;
  v_representative jsonb;
  v_skus jsonb;
  v_count integer;
  v_unallocated_count integer;
begin
  v_probe=app.marketplace_extension_probe(p_marketplace,p_item_id);

  select coalesce(jsonb_agg(e.value || jsonb_build_object(
    'receipt_ready', readiness.source is not null,
    'receipt_source', readiness.source,
    'receipt_parent_sku', case when i.is_accessory and p.id is not null and not p.is_accessory then p.sku else null end
  ) order by i.id),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_probe->'items') e(value)
  join app.items i on i.id=(e.value->>'id')::uuid
  left join app.items p on i.is_accessory and p.id=i.parent_item_id
  cross join lateral (
    select case
      when p_marketplace='ヤフオク' and app.receipt_contact_disposition_ready(i) then 'disposition'
      when i.inspected_at is not null then 'own'
      when i.is_accessory and not p.is_accessory
        and p.inspected_at is not null then 'parent'
      when p_marketplace='ヤフオク' and app.receipt_contact_accessory_approved(i,p) then 'accessory_approved'
    end as source
  ) readiness;

  if p_marketplace='ヤフオク' and exists (
    with matching_items as materialized (
      select i as inventory_item
      from jsonb_array_elements(v_items) e(value)
      join app.items i on i.id=(e.value->>'id')::uuid
    )
    select 1 from matching_items
    where app.receipt_bundle_is_waiting(inventory_item)
  ) then
    -- Older extensions use the timestamps as a fallback eligibility signal.
    select jsonb_agg((e.value - 'inspected_at') ||
      jsonb_build_object('receipt_ready',false,'receipt_source',null) order by e.ordinality)
      into v_items from jsonb_array_elements(v_items) with ordinality e(value,ordinality);
    return v_probe || jsonb_build_object('items',v_items,'receipt_bundle_waiting',true);
  end if;

  v_count=jsonb_array_length(v_items);
  if p_marketplace='ヤフオク' and v_count between 2 and 40 then
    with members as (
      select e.value,i.is_accessory,
        coalesce((e.value->>'receipt_ready')::boolean,false) as ready,
        i.is_accessory and i.parent_item_id is not null and exists(
          select 1 from app.spare_accessories s
          where s.marketplace_item_id=p_item_id and s.marketplace='ヤフオク'
          and (s.used_for_item_id=i.parent_item_id or exists(
            select 1 from app.spare_shipping_tasks t
            where t.spare_id=s.id and t.accessory_item_id=i.id and t.item_id=i.parent_item_id
          ))
        ) as allocated
      from jsonb_array_elements(v_items) e(value)
      join app.items i on i.id=(e.value->>'id')::uuid
    )
    select bool_and(ready or allocated),
      bool_or(ready and not allocated),
      jsonb_agg(value->>'sku' order by value->>'sku'),
      count(*) filter (where not allocated),
      (select value from members where not allocated order by is_accessory,value->>'id' limit 1)
      into v_group_ok,v_source_ready,v_skus,v_unallocated_count,v_representative
    from members;

    -- A single unallocated row identifies the transaction source even if
    -- inspection/cleaning is incomplete. Readiness is still enforced by the
    -- extension's eligibility check before any rating can be sent.
    if v_unallocated_count=1 and v_representative is not null then
      return v_probe || jsonb_build_object(
        'inventory_count',v_count,'count',1,
        'items',jsonb_build_array(v_representative),
        'receipt_group_size',v_count,
        'receipt_group_skus',v_skus,
        'receipt_group_basis','same_yahoo_purchase_verified_source_and_allocation'
      );
    end if;

    if v_group_ok and v_source_ready and v_representative is not null then
      return v_probe || jsonb_build_object(
        'inventory_count',v_count,'count',1,
        'items',jsonb_build_array(v_representative),
        'receipt_group_size',v_count,
        'receipt_group_skus',v_skus,
        'receipt_group_basis','same_yahoo_purchase_verified_source_and_allocation'
      );
    end if;
  end if;
  return v_probe || jsonb_build_object('items',v_items);
end
$function$;

CREATE OR REPLACE FUNCTION app.marketplace_extension_receipt(p_action text, p_marketplace app.marketplace, p_item_id text, p_account_label text, p_token uuid DEFAULT NULL::uuid, p_details text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare v_market text; v_probe jsonb; v_row app.marketplace_extension_receipts%rowtype; v_token uuid;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です'; end if;
  if p_action not in ('reserve','begin','complete','unknown','release','review_unpublished') then raise exception '操作が不正です'; end if;
  if nullif(trim(p_account_label),'') is null or length(p_account_label)>200 then raise exception 'アカウント識別が必要です'; end if;
  v_probe=app.marketplace_receipt_context(p_marketplace,p_item_id);
  v_market=case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end;
  perform pg_advisory_xact_lock(hashtextextended(v_market||':'||p_item_id,0));
  select * into v_row from app.marketplace_extension_receipts where marketplace=v_market and marketplace_item_id=p_item_id for update;

  -- Explicit operator review only; keep the existing unknown reservation intact.
  if p_action='review_unpublished' then
    if v_row.state is distinct from 'unknown'
      or v_row.reserved_by is distinct from auth.uid()
      or v_row.account_label is distinct from p_account_label then
      return jsonb_build_object('eligible',false,'reason','Result review does not match the existing reservation');
    end if;
    if (v_probe->>'count')::int<>1
      or coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then
      return jsonb_build_object('eligible',false,'reason','Inspection and cleaning eligibility changed');
    end if;
    return jsonb_build_object('eligible',true,'token',v_row.token,'reviewed',true,'sku',v_probe->'items'->0->>'sku');
  end if;
  if p_action='reserve' then
    if (v_probe->>'count')::int<>1 then return jsonb_build_object('eligible',false,'reason','在庫1件一致が必要です'); end if;
    if coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then return jsonb_build_object('eligible',false,'reason','検品または受け取り連絡の判断待ち'); end if;
    if v_row.state is not null then return jsonb_build_object('eligible',false,'reason','既存の評価記録: '||v_row.state); end if;
    insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
      values(v_market,p_item_id,p_account_label,'reserved',auth.uid()) returning token into v_token;
    return jsonb_build_object('eligible',true,'token',v_token,'sku',v_probe->'items'->0->>'sku');
  end if;
  if v_row.token is distinct from p_token or v_row.reserved_by is distinct from auth.uid() or v_row.account_label<>p_account_label then raise exception '評価予約が一致しません'; end if;
  if p_action='begin' then
    if v_row.state<>'reserved' or v_row.reserved_at<now()-interval '5 minutes' then raise exception '評価予約が期限切れか送信済みです'; end if;
    if (v_probe->>'count')::int<>1 or coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then raise exception '評価条件が変わりました'; end if;
    update app.marketplace_extension_receipts set state='submitting',updated_at=now() where token=p_token;
  elsif p_action='release' then
    if v_row.state<>'reserved' then raise exception '送信開始後は予約を解除できません'; end if;
    delete from app.marketplace_extension_receipts where token=p_token;
  elsif p_action in ('complete','unknown') then
    if v_row.state not in ('submitting','unknown') then raise exception '送信状態が不正です'; end if;
    update app.marketplace_extension_receipts set state=case when p_action='complete' then 'succeeded' else 'unknown' end,details=left(p_details,2000),updated_at=now() where token=p_token;
  end if;
  return jsonb_build_object('ok',true);
end $function$;

create or replace view app.v_admin_work_deadlines
with (security_invoker=true, security_barrier=true) as
WITH candidates AS (
         SELECT i.id,
            i.sku,
            i.lot_seq,
            i.sales_channel,
            i.marketplace,
            i.marketplace_item_id,
            i.marketplace_url,
            t.recorded_at,
            i.status,
            GREATEST(i.inspected_at, i.malfunction_reported_at) AS action_at,
            i.listed_on,
            app.sales_channel_family(i.sales_channel) AS channel,
            (i.is_accessory AND (NOT app.is_standalone_accessory_serial(i.sku, i.lot_seq))) AS linked_accessory,
            parent.id AS parent_id,
            GREATEST(parent.inspected_at, parent.malfunction_reported_at) AS parent_action_at
           FROM ((app.items i
             JOIN app.item_tracking_recordings t ON ((t.item_id = i.id)))
             LEFT JOIN app.items parent ON (((parent.id = i.parent_item_id) AND (NOT parent.is_accessory))))
          WHERE ((( SELECT auth.uid() AS uid) IS NOT NULL) AND ( SELECT app.is_admin() AS is_admin) AND (EXISTS ( SELECT 1
                   FROM app.staff s
                  WHERE ((s.id = ( SELECT app.current_staff_id() AS current_staff_id)) AND s.is_active))) AND (i.deliverer_id IS NOT NULL) AND (i.sold_on IS NULL) AND (i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status, '商品登録前'::app.item_status])) AND (NULLIF(btrim(i.tracking_no), ''::text) IS NOT NULL))
        )
 SELECT i.id,
    i.id AS item_id,
    i.sku,
    i.lot_seq,
    i.sales_channel,
    i.marketplace,
    i.marketplace_item_id,
    i.marketplace_url,
    i.recorded_at AS created_at,
    'listing'::text AS kind,
    i.id AS action_item_id
   FROM candidates i
  WHERE ((NOT i.linked_accessory) AND (i.recorded_at <= (now() - '7 days'::interval)) AND (i.listed_on IS NULL) AND (i.channel = ANY (ARRAY['メルカリ'::app.sales_channel, 'ヤフオク'::app.sales_channel, '自己発送'::app.sales_channel, 'FBA'::app.sales_channel, 'ヤフフリ'::app.sales_channel])) AND ((i.channel <> 'FBA'::app.sales_channel) OR (NOT workload_private.delivery_fba_confirmed(i.id))))
UNION ALL
 SELECT i.id,
    i.id AS item_id,
    i.sku,
    i.lot_seq,
    i.sales_channel,
    i.marketplace,
    i.marketplace_item_id,
    i.marketplace_url,
    i.recorded_at AS created_at,
    'inspection'::text AS kind,
        CASE
            WHEN i.linked_accessory THEN COALESCE(i.parent_id, i.id)
            ELSE i.id
        END AS action_item_id
   FROM candidates i
  WHERE ((i.recorded_at <= (now() - '3 days'::interval)) AND (i.action_at IS NULL) AND ((i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status])) OR i.linked_accessory) AND (NOT (i.linked_accessory AND COALESCE((i.parent_action_at >= i.recorded_at), false))))
UNION ALL
 SELECT t.id,
    i.id AS item_id,
    i.sku,
    i.lot_seq,
    i.sales_channel,
    i.marketplace,
    i.marketplace_item_id,
    i.marketplace_url,
    t.created_at,
    'shipping'::text AS kind,
    i.id AS action_item_id
   FROM (app.delivery_shipping_tasks t
     JOIN app.items i ON ((i.id = t.item_id)))
  WHERE ((( SELECT auth.uid() AS uid) IS NOT NULL) AND ( SELECT app.is_admin() AS is_admin) AND (EXISTS ( SELECT 1
           FROM app.staff s
          WHERE ((s.id = ( SELECT app.current_staff_id() AS current_staff_id)) AND s.is_active))) AND (t.resolved_at IS NULL) AND (t.created_at <= (now() - '24:00:00'::interval)) AND (i.status = ANY (ARRAY['取引中'::app.item_status, '販売済'::app.item_status])) AND (i.shipped_on IS NULL) AND (NOT app.current_trade_completed(i.id)) AND (app.sales_channel_family(i.sales_channel) = ANY (ARRAY['メルカリ'::app.sales_channel, 'ヤフオク'::app.sales_channel, '自己発送'::app.sales_channel])));

create or replace view app.v_delivery_work_tasks
with (security_invoker=true, security_barrier=true) as
WITH notices AS MATERIALIZED (
         SELECT n.id,
            n.item_id,
            n.kind,
            n.created_at,
            n.sku,
            n.lot_seq,
            n.marketplace_item_id,
            n.marketplace,
            n.marketplace_url,
            n.expires_at,
            n.reason,
            t.recorded_at AS tracking_recorded_at
           FROM (app.v_delivery_notice_tasks n
             LEFT JOIN app.item_tracking_recordings t ON ((t.item_id = n.item_id)))
          WHERE ((n.kind <> 'photo_approved'::text) OR (NOT workload_private.delivery_fba_confirmed(n.item_id)))
        ), candidates AS (
         SELECT i.id,
            i.sku,
            i.lot_seq,
            i.marketplace_item_id,
            i.marketplace,
            i.marketplace_url,
            i.created_at,
            t.recorded_at,
            i.status,
            i.inspected_at,
            i.malfunction_reported_at,
            i.listed_on,
            app.sales_channel_family(i.sales_channel) AS channel
           FROM (app.items i
             LEFT JOIN app.item_tracking_recordings t ON ((t.item_id = i.id)))
          WHERE ((( SELECT auth.uid() AS uid) IS NOT NULL) AND (EXISTS ( SELECT 1
                   FROM app.staff s
                  WHERE ((s.id = ( SELECT app.current_staff_id() AS current_staff_id)) AND s.is_active))) AND (( SELECT app.is_admin() AS is_admin) OR (i.deliverer_id = ( SELECT app.current_staff_id() AS current_staff_id))) AND (i.deliverer_id IS NOT NULL) AND ((NOT i.is_accessory) OR app.is_standalone_accessory_serial(i.sku, i.lot_seq)) AND (i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status, '商品登録前'::app.item_status])) AND (i.sold_on IS NULL) AND (NULLIF(btrim(i.tracking_no), ''::text) IS NOT NULL))
        )
 SELECT notices.id,
    notices.item_id,
    notices.kind,
    notices.created_at,
    notices.sku,
    notices.lot_seq,
    notices.marketplace_item_id,
    notices.marketplace,
    notices.marketplace_url,
    notices.expires_at,
    notices.reason,
    notices.tracking_recorded_at
   FROM notices
UNION ALL
 SELECT ('inspection:'::text || (i.id)::text) AS id,
    i.id AS item_id,
    'inspection'::text AS kind,
    COALESCE(i.recorded_at, i.created_at) AS created_at,
    i.sku,
    i.lot_seq,
    i.marketplace_item_id,
    i.marketplace,
    i.marketplace_url,
    NULL::timestamp with time zone AS expires_at,
    NULL::text AS reason,
    i.recorded_at AS tracking_recorded_at
   FROM candidates i
  WHERE ((i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status])) AND (i.inspected_at IS NULL) AND (i.malfunction_reported_at IS NULL))
UNION ALL
 SELECT ('listing_due:'::text || (i.id)::text) AS id,
    i.id AS item_id,
    'listing_due'::text AS kind,
    i.recorded_at AS created_at,
    i.sku,
    i.lot_seq,
    i.marketplace_item_id,
    i.marketplace,
    i.marketplace_url,
    NULL::timestamp with time zone AS expires_at,
    NULL::text AS reason,
    i.recorded_at AS tracking_recorded_at
   FROM candidates i
  WHERE ((i.recorded_at IS NOT NULL) AND (i.listed_on IS NULL) AND (i.channel = ANY (ARRAY['FBA'::app.sales_channel, '自己発送'::app.sales_channel, 'メルカリ'::app.sales_channel, 'ヤフオク'::app.sales_channel, 'ヤフフリ'::app.sales_channel])) AND (NOT (EXISTS ( SELECT 1
           FROM notices n
          WHERE ((n.item_id = i.id) AND (n.kind = 'photo_approved'::text))))) AND ((i.channel <> 'FBA'::app.sales_channel) OR (NOT workload_private.delivery_fba_confirmed(i.id))));

create or replace view app.v_deliverer_stock_workload_items
with (security_invoker=true, security_barrier=true) as
SELECT i.id,
    i.deliverer_id,
    i.lot_seq,
    i.sku,
    i.title,
    p.model_no,
    i.status,
    i.marketplace,
    i.sales_channel,
    i.purchased_at,
    i.packed_on,
    i.shipped_on,
    state.bucket,
    COALESCE(((i.shipped_on IS NULL) AND (NOT location.left_for_fba) AND ((state.bucket = ANY (ARRAY['登録前'::text, '手元出品'::text, '発送前'::text, '手元不良'::text])) OR ((state.bucket = '検品中'::text) AND ((i.inspected_at IS NOT NULL))))), false) AS on_hand
   FROM ((((app.items i
     LEFT JOIN app.products p ON ((p.id = i.product_id)))
     LEFT JOIN workload_private.fba_stock_evidence f ON (((f.item_id = i.id) AND (f.sku = i.sku) AND (f.account =
        CASE
            WHEN ((i.sales_channel)::text = 'FBA'::text) THEN 'FBA1'::text
            ELSE (i.sales_channel)::text
        END))))
     CROSS JOIN LATERAL ( SELECT COALESCE((f.received OR f.dispatched), false) AS left_for_fba,
            ((i.sales_channel)::text = ANY (ARRAY['自己発送'::text, '自己発送1'::text, '自己発送2'::text, 'メルカリ'::text, 'ヤフオク'::text, 'ヤフフリ'::text])) AS self_fulfilled) location)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN (i.status = '受取前'::app.item_status) THEN '受取前'::text
                    WHEN (i.status = '検品中'::app.item_status) THEN '検品中'::text
                    WHEN (i.status = 'Amazon返送依頼'::app.item_status) THEN 'Amazon返品'::text
                    WHEN (i.status = '商品登録前'::app.item_status) THEN '登録前'::text
                    WHEN ((i.status = '出品中'::app.item_status) AND location.self_fulfilled AND (i.shipped_on IS NULL)) THEN '手元出品'::text
                    WHEN ((i.status = '出品中'::app.item_status) AND f.received) THEN 'FBA出品'::text
                    WHEN ((i.status = '取引中'::app.item_status) AND (i.shipped_on IS NOT NULL)) THEN '発送済み'::text
                    WHEN ((i.status = '取引中'::app.item_status) AND location.self_fulfilled) THEN '発送前'::text
                    WHEN ((i.status = '動作不良'::app.item_status) AND (i.shipped_on IS NULL) AND (NOT location.left_for_fba) AND ((i.inspected_at IS NOT NULL) OR (i.malfunction_reported_at IS NOT NULL))) THEN '手元不良'::text
                    ELSE NULL::text
                END AS bucket) state)
  WHERE (( SELECT app.management_reports_allowed() AS management_reports_allowed) AND (NOT i.is_accessory) AND (i.deliverer_id IS NOT NULL) AND (i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status, 'Amazon返送依頼'::app.item_status, '商品登録前'::app.item_status, '出品中'::app.item_status, '取引中'::app.item_status, '動作不良'::app.item_status])));

create or replace view app.v_receipt_evaluation_tasks
with (security_invoker=true) as
WITH eligible AS (
         SELECT t.item_id AS id,
            t.item_id,
            t.requested_at,
            i.sku,
            i.lot_seq,
            i.title,
            p.model_no,
            i.asin,
            i.marketplace,
            i.marketplace_item_id,
            i.marketplace_url,
            i.is_accessory,
            row_number() OVER (PARTITION BY (app.receipt_purchase_market(i.marketplace)), COALESCE(NULLIF(btrim(i.marketplace_item_id), ''::text), (i.id)::text) ORDER BY i.is_accessory, t.requested_at, i.id) AS purchase_rank
           FROM (((app.receipt_evaluation_tasks t
             JOIN app.items i ON ((i.id = t.item_id)))
             LEFT JOIN app.products p ON ((p.id = i.product_id)))
             LEFT JOIN app.items parent ON (((parent.id = i.parent_item_id) AND (NOT parent.is_accessory) AND (parent.id <> i.id))))
          WHERE ((t.completed_at IS NULL) AND (NOT app.receipt_item_is_spare_accessory(i.*)) AND (NOT app.receipt_bundle_is_waiting(i.*)) AND (((i.inspected_at IS NOT NULL)) OR (i.is_accessory AND (parent.inspected_at IS NOT NULL))) AND ((NOT i.is_accessory) OR (parent.id IS NULL) OR ((app.receipt_purchase_market(i.marketplace) IS DISTINCT FROM app.receipt_purchase_market(parent.marketplace)) OR (i.marketplace_item_id IS DISTINCT FROM parent.marketplace_item_id))) AND (i.marketplace = ANY (ARRAY['メルカリ'::app.marketplace, 'ヤフオク'::app.marketplace, 'ヤフフリ'::app.marketplace, 'PayPayフリマ'::app.marketplace, 'ラクマ'::app.marketplace])) AND (NOT (EXISTS ( SELECT 1
                   FROM app.marketplace_extension_receipts r
                  WHERE ((r.marketplace = app.receipt_purchase_market(i.marketplace)) AND (r.marketplace_item_id = i.marketplace_item_id) AND (r.state = 'succeeded'::text))))) AND (NOT (EXISTS ( SELECT 1
                   FROM (app.receipt_evaluation_tasks done
                     JOIN app.items d ON ((d.id = done.item_id)))
                  WHERE ((done.completed_at IS NOT NULL) AND (NULLIF(btrim(i.marketplace_item_id), ''::text) IS NOT NULL) AND (d.marketplace_item_id = i.marketplace_item_id) AND (app.receipt_purchase_market(d.marketplace) = app.receipt_purchase_market(i.marketplace)))))))
        )
 SELECT id,
    item_id,
    requested_at,
    sku,
    lot_seq,
    title,
    model_no,
    asin,
    marketplace,
    marketplace_item_id,
    marketplace_url,
    is_accessory
   FROM eligible
  WHERE (purchase_rank = 1);

notify pgrst,'reload schema';

