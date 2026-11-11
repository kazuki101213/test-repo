-- Buyer receipt contact can follow an explicit no-return/Yahoo-sale disposition.
create function app.receipt_contact_disposition_ready(p_item app.items)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(
   not (p_item).is_accessory
   and (p_item).marketplace='ヤフオク'
   and (p_item).workflow_decision='yahoo'
   and (p_item).status in ('商品登録前','出品中','取引中','販売済')
   and (p_item).inspected_at is not null
   and (p_item).malfunction_reported_at is not null
   and (p_item).malfunction_resolved_at >= (p_item).malfunction_reported_at,
   false
 )
$$;
revoke all on function app.receipt_contact_disposition_ready(app.items) from public,anon;
grant execute on function app.receipt_contact_disposition_ready(app.items) to authenticated,service_role;

-- An approval identifies the purchased accessory, its current parent and the fault report.
create function app.receipt_contact_accessory_approved(p_item app.items,p_parent app.items)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(
   (p_item).is_accessory and (p_item).marketplace='ヤフオク'
   and not (p_parent).is_accessory
   and (p_parent).id=(p_item).parent_item_id
   and (p_parent).status='動作不良'
   and (p_parent).malfunction_reported_at is not null
   and (p_item).malfunction_reported_at is null and not (p_item).malfunction_reported
   and (p_item).marketplace_item_id is distinct from (p_parent).marketplace_item_id
   and exists (
     select 1 from app.inventory_workflow_events event
     where event.item_id=(p_item).id
       and event.action='receipt_contact_accessory_approved'
       and event.created_at >= (p_parent).malfunction_reported_at
       and starts_with(event.note,'site='||(p_item).marketplace_item_id||';parent='||(p_parent).id||';')
   ),
   false
 )
$$;
revoke all on function app.receipt_contact_accessory_approved(app.items,app.items) from public,anon;
grant execute on function app.receipt_contact_accessory_approved(app.items,app.items) to authenticated,service_role;

create function app.approve_yahoo_accessory_receipt_contact(p_item_id uuid,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare
  actor uuid := app.current_staff_id();
  accessory app.items;
  parent app.items;
begin
  if auth.uid() is null or not app.is_admin()
     or not exists (select 1 from app.staff s where s.id=actor and s.is_active) then
    raise exception '管理者のみ操作できます' using errcode='42501';
  end if;
  select * into accessory from app.items where id=p_item_id for update;
  select * into parent from app.items where id=accessory.parent_item_id;
  if accessory.id is null or not accessory.is_accessory or accessory.marketplace is distinct from 'ヤフオク'
     or nullif(btrim(accessory.marketplace_item_id),'') is null
     or parent.id is null or parent.is_accessory or parent.status is distinct from '動作不良'
     or parent.malfunction_reported_at is null
     or accessory.malfunction_reported or accessory.malfunction_reported_at is not null
     or accessory.marketplace_item_id is not distinct from parent.marketplace_item_id
     or nullif(btrim(p_note),'') is null then
    raise exception '本体とは別に仕入れた、動作不良の報告がない付属品を確認してください' using errcode='22023';
  end if;
  if app.receipt_contact_accessory_approved(accessory,parent) then return; end if;
  insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note)
  values(gen_random_uuid(),accessory.id,actor,'receipt_contact_accessory_approved',accessory.status,accessory.status,
    'site='||accessory.marketplace_item_id||';parent='||parent.id||';'||left(btrim(p_note),1000));
end
$$;
revoke all on function app.approve_yahoo_accessory_receipt_contact(uuid,text) from public,anon;
grant execute on function app.approve_yahoo_accessory_receipt_contact(uuid,text) to authenticated;

CREATE OR REPLACE FUNCTION app.receipt_bundle_is_waiting(p_item app.items)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  source_lot text := (p_item).lot_seq::text;
  source_lots text[];
  source_tracking text;
begin
  if (p_item).marketplace is distinct from 'ヤフオク' or (p_item).is_accessory is distinct from false then
    return false;
  end if;
  source_lots := app.receipt_bundle_lots((p_item).memo);
  source_tracking := regexp_replace((p_item).tracking_no,'[[:space:]－-]','','g');

  return exists (
    select 1
    from app.items sibling
    where sibling.marketplace='ヤフオク'
      and not sibling.is_accessory
      and sibling.id<>(p_item).id
      and (sibling.inspected_at is null or sibling.cleaned_at is null)
      and not app.receipt_contact_disposition_ready(sibling)
      and (
        case when source_tracking ~ '^[0-9]{8,20}$'
          then source_tracking=regexp_replace(sibling.tracking_no,'[[:space:]－-]','','g')
          else false end
        or (source_lot=any(source_lots) and sibling.lot_seq::text=any(source_lots))
        or case when sibling.memo like '%同梱%' and strpos(sibling.memo,source_lot)>0
          then app.receipt_bundle_lots(sibling.memo) @> array[source_lot,sibling.lot_seq::text]
          else false end
      )
  );
end
$function$;

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
      when i.inspected_at is not null and i.cleaned_at is not null then 'own'
      when p_marketplace='ヤフオク' and app.receipt_contact_disposition_ready(i) then 'disposition'
      when i.is_accessory and not p.is_accessory
        and p.inspected_at is not null and p.cleaned_at is not null then 'parent'
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
    select jsonb_agg((e.value - 'inspected_at' - 'cleaned_at') ||
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

notify pgrst,'reload schema';

