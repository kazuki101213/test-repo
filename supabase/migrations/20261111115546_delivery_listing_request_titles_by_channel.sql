create or replace function app.delivery_listing_request_title(p_channel app.sales_channel)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case app.sales_channel_family(p_channel)
    when 'FBA' then 'FBA納品お願いします。'
    when 'ヤフオク' then 'ヤフオク出品お願いします。'
    when 'メルカリ' then 'メルカリ出品お願いします。'
    when '自己発送' then '自己発送の出品お願いします。'
    else null
  end;
$$;

revoke all on function app.delivery_listing_request_title(app.sales_channel) from public, anon;
grant execute on function app.delivery_listing_request_title(app.sales_channel) to authenticated, service_role;

create or replace view app.v_delivery_work_tasks
with (security_invoker = true, security_barrier = true)
as
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
            t.recorded_at AS tracking_recorded_at,
            app.delivery_listing_request_title(i.sales_channel) AS listing_request_title
           FROM app.v_delivery_notice_tasks n
             LEFT JOIN app.items i ON i.id=n.item_id AND n.kind='photo_approved'
             LEFT JOIN app.item_tracking_recordings t ON t.item_id = n.item_id
          WHERE n.kind <> 'photo_approved'::text OR NOT workload_private.delivery_fba_confirmed(n.item_id)
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
           FROM app.items i
             LEFT JOIN app.item_tracking_recordings t ON t.item_id = i.id
          WHERE (( SELECT auth.uid() AS uid)) IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM app.staff s
                  WHERE s.id = (( SELECT app.current_staff_id() AS current_staff_id)) AND s.is_active)) AND (( SELECT app.is_admin() AS is_admin) OR i.deliverer_id = (( SELECT app.current_staff_id() AS current_staff_id))) AND i.deliverer_id IS NOT NULL AND (NOT i.is_accessory OR app.is_standalone_accessory_serial(i.sku, i.lot_seq)) AND (i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status, '商品登録前'::app.item_status])) AND i.sold_on IS NULL AND NULLIF(btrim(i.tracking_no), ''::text) IS NOT NULL
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
    notices.tracking_recorded_at,
    notices.listing_request_title
   FROM notices
UNION ALL
 SELECT 'inspection:'::text || i.id::text AS id,
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
    i.recorded_at AS tracking_recorded_at,
    NULL::text AS listing_request_title
   FROM candidates i
  WHERE (i.status = ANY (ARRAY['受取前'::app.item_status, '検品中'::app.item_status])) AND i.inspected_at IS NULL AND i.malfunction_reported_at IS NULL
UNION ALL
 SELECT 'listing_due:'::text || i.id::text AS id,
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
    i.recorded_at AS tracking_recorded_at,
    app.delivery_listing_request_title(i.channel) AS listing_request_title
   FROM candidates i
  WHERE i.recorded_at IS NOT NULL AND i.listed_on IS NULL AND (i.channel = ANY (ARRAY['FBA'::app.sales_channel, '自己発送'::app.sales_channel, 'メルカリ'::app.sales_channel, 'ヤフオク'::app.sales_channel, 'ヤフフリ'::app.sales_channel])) AND NOT (EXISTS ( SELECT 1
           FROM notices n
          WHERE n.item_id = i.id AND n.kind = 'photo_approved'::text)) AND (i.channel <> 'FBA'::app.sales_channel OR NOT workload_private.delivery_fba_confirmed(i.id));

create or replace function app.claim_delivery_push_with_listing_title()
returns setof jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select to_jsonb(c) || case when c.kind = 'photo'
    then jsonb_build_object('listing_request_title', app.delivery_listing_request_title(i.sales_channel))
    else '{}'::jsonb end
  from app.claim_delivery_push() c
  left join app.items i on i.id = c.item_id and c.kind = 'photo';
$$;

revoke all on function app.claim_delivery_push_with_listing_title() from public, anon, authenticated;
grant execute on function app.claim_delivery_push_with_listing_title() to service_role;
