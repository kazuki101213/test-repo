-- A separately purchased spare may still have an open seller evaluation.
-- Keep ordinary spare exclusions and show only cases verified on the marketplace.
alter table app.receipt_evaluation_tasks
  add column marketplace_evaluation_verified_at timestamptz;
comment on column app.receipt_evaluation_tasks.marketplace_evaluation_verified_at is
  'When an open seller evaluation was verified on the purchase marketplace for manual follow-up.';

create or replace view app.v_receipt_evaluation_tasks with (security_invoker = true) as
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
          WHERE ((t.completed_at IS NULL) AND ((NOT app.receipt_item_is_spare_accessory(i.*)) OR t.marketplace_evaluation_verified_at IS NOT NULL) AND (NOT app.receipt_bundle_is_waiting(i.*)) AND ((i.inspected_at IS NOT NULL) OR (i.is_accessory AND (parent.inspected_at IS NOT NULL))) AND ((NOT i.is_accessory) OR (parent.id IS NULL) OR ((app.receipt_purchase_market(i.marketplace) IS DISTINCT FROM app.receipt_purchase_market(parent.marketplace)) OR (i.marketplace_item_id IS DISTINCT FROM parent.marketplace_item_id))) AND (i.marketplace = ANY (ARRAY['メルカリ'::app.marketplace, 'ヤフオク'::app.marketplace, 'ヤフフリ'::app.marketplace, 'PayPayフリマ'::app.marketplace, 'ラクマ'::app.marketplace])) AND (t.marketplace_evaluation_verified_at IS NOT NULL OR NOT (EXISTS ( SELECT 1
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

CREATE OR REPLACE FUNCTION app.complete_receipt_evaluation_task(p_item_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 if exists(select 1 from app.items i where i.id=p_item_id and app.receipt_item_is_spare_accessory(i))
    and not exists (
      select 1 from app.receipt_evaluation_tasks t
      where t.item_id=p_item_id and t.marketplace_evaluation_verified_at is not null
    ) then
  raise exception '予備・付属品から割り当てた付属品は受取評価の対象外です' using errcode='22023';
 end if;
 if exists(select 1 from app.items i where i.id=p_item_id and app.receipt_bundle_is_waiting(i)) then
  raise exception '同梱の本体がすべて検品・清掃完了するまで受取評価を保留します' using errcode='22023';
 end if;
 if not exists(select 1 from app.receipt_evaluation_tasks where item_id=p_item_id) then
  raise exception '受取評価のやることがありません' using errcode='22023';
 end if;
 update app.receipt_evaluation_tasks t
 set completed_at=coalesce(t.completed_at,clock_timestamp()),completed_by=coalesce(t.completed_by,app.current_staff_id())
 from app.items i,app.items target
 where i.id=t.item_id and target.id=p_item_id
 and (i.id=target.id or (nullif(btrim(target.marketplace_item_id),'') is not null
   and i.marketplace_item_id=target.marketplace_item_id
   and app.receipt_purchase_market(i.marketplace)=app.receipt_purchase_market(target.marketplace)));
end $function$;
