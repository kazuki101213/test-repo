-- Receipt-only readiness. Tracking continues to use the unchanged exact-one probe.
create or replace function app.marketplace_receipt_context(p_marketplace app.marketplace,p_item_id text)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare v_probe jsonb; v_items jsonb; v_group_ok boolean; v_source_ready boolean; v_representative jsonb; v_skus jsonb; v_count integer;
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
    select bool_and(ready or allocated),bool_or(ready and not allocated),
      jsonb_agg(value->>'sku' order by value->>'sku'),
      (select value from members where ready and not allocated order by is_accessory,value->>'id' limit 1)
      into v_group_ok,v_source_ready,v_skus,v_representative from members;
    if v_group_ok and v_source_ready and v_representative is not null then
      return v_probe || jsonb_build_object('inventory_count',v_count,'count',1,
        'items',jsonb_build_array(v_representative),'receipt_group_size',v_count,
        'receipt_group_skus',v_skus,'receipt_group_basis','same_yahoo_purchase_verified_source_and_allocation');
    end if;
  end if;
  return v_probe || jsonb_build_object('items',v_items);
end $$;
revoke all on function app.marketplace_receipt_context(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_receipt_context(app.marketplace,text) to authenticated;
