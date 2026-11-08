-- A Yahoo purchase may share its parcel with other main units under different auction IDs.
create function app.receipt_bundle_lots(p_memo text)
returns text[] language sql immutable strict set search_path='' as $$
 select coalesce(array_agg(distinct btrim(lot)),array[]::text[])
 from regexp_matches(p_memo,
   '^[[:blank:]]*([0-9]{1,9}([[:blank:]]*[、,，。][[:blank:]]*[0-9]{1,9})+)[[:blank:]]*同梱([[:blank:]。．.]|$)',
   'gn') as match
 cross join lateral regexp_split_to_table(match[1],'[、,，。]') as lot
$$;
revoke all on function app.receipt_bundle_lots(text) from public,anon;
grant execute on function app.receipt_bundle_lots(text) to authenticated,service_role;

create function app.receipt_bundle_is_waiting(p_item app.items)
returns boolean language sql stable security invoker set search_path='' as $$
 select case when (p_item).marketplace='ヤフオク' and not (p_item).is_accessory then exists (
   select 1
   from app.items sibling
   cross join (
     select app.receipt_bundle_lots((p_item).memo) as lots,
       regexp_replace((p_item).tracking_no,'[[:space:]－-]','','g') as tracking
   ) source
   where sibling.marketplace=(p_item).marketplace and not sibling.is_accessory
     and sibling.id<>(p_item).id
     and (sibling.inspected_at is null or sibling.cleaned_at is null)
     and (
       (source.tracking ~ '^[0-9]{8,20}$'
         and source.tracking=regexp_replace(sibling.tracking_no,'[[:space:]－-]','','g'))
       or (source.lots @> array[(p_item).lot_seq::text,sibling.lot_seq::text])
       or (app.receipt_bundle_lots(sibling.memo) @> array[(p_item).lot_seq::text,sibling.lot_seq::text])
     )
 ) else false end
$$;
revoke all on function app.receipt_bundle_is_waiting(app.items) from public,anon;
grant execute on function app.receipt_bundle_is_waiting(app.items) to authenticated,service_role;

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
    'receipt_ready', (i.inspected_at is not null and i.cleaned_at is not null) or
      (i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null),
    'receipt_source', case when i.inspected_at is not null and i.cleaned_at is not null then 'own'
      when i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null then 'parent' else null end,
    'receipt_parent_sku', case when i.is_accessory and p.id is not null and not p.is_accessory then p.sku else null end
  ) order by i.id),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_probe->'items') e(value)
  join app.items i on i.id=(e.value->>'id')::uuid
  left join app.items p on i.is_accessory and p.id=i.parent_item_id;

  if p_marketplace='ヤフオク' and exists (
    select 1 from jsonb_array_elements(v_items) e(value)
    join app.items i on i.id=(e.value->>'id')::uuid
    where app.receipt_bundle_is_waiting(i)
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

create or replace view app.v_receipt_evaluation_tasks with(security_invoker=true) as
with eligible as (
 select t.item_id as id,t.item_id,t.requested_at,i.sku,i.lot_seq,i.title,p.model_no,i.asin,
 i.marketplace,i.marketplace_item_id,i.marketplace_url,i.is_accessory,
 row_number() over(partition by app.receipt_purchase_market(i.marketplace),
   coalesce(nullif(btrim(i.marketplace_item_id),''),i.id::text)
   order by i.is_accessory,t.requested_at,i.id) as purchase_rank
 from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id
 left join app.products p on p.id=i.product_id
 left join app.items parent on parent.id=i.parent_item_id and not parent.is_accessory and parent.id<>i.id
 where t.completed_at is null and not app.receipt_item_is_spare_accessory(i)
 and not app.receipt_bundle_is_waiting(i)
 and ((i.inspected_at is not null and i.cleaned_at is not null)
   or (i.is_accessory and parent.inspected_at is not null and parent.cleaned_at is not null))
 and (not i.is_accessory or parent.id is null
   or row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
     is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id))
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and nullif(btrim(i.marketplace_item_id),'') is not null
   and d.marketplace_item_id=i.marketplace_item_id and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
)
select id,item_id,requested_at,sku,lot_seq,title,model_no,asin,marketplace,marketplace_item_id,marketplace_url,is_accessory
from eligible where purchase_rank=1;

create or replace function app.complete_receipt_evaluation_task(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 if exists(select 1 from app.items i where i.id=p_item_id and app.receipt_item_is_spare_accessory(i)) then
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
end $$;

notify pgrst,'reload schema';
