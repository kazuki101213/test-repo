create or replace function app.publish_fba_inbound_items(p_plan uuid, p_items uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  published_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception '内部処理専用です' using errcode = '42501';
  end if;

  with verified as (
    update app.items i
    set status = '出品中', product_registered_at = coalesce(i.product_registered_at, now())
    from app.fba_inbound_items f join app.fba_inbound_plans p on p.id = f.plan_id
    where p.id = p_plan and p.stage = 'ready' and p.pending is null
      and f.released_at is null and f.published_at is null
      and i.id = f.item_id and i.id = any(p_items)
      and app.inventory_sku_matches(i.id, i.sku, f.sku)
      and btrim(i.asin::text) = f.asin and i.condition::text = f.condition and i.deliverer_id = p.staff_id
      and i.status = '商品登録前' and i.sold_on is null and i.returned_on is null
      and (i.sales_channel::text = p.account or (i.sales_channel::text = 'FBA' and p.account = 'FBA1'))
      and exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(p.work->'shipments') = 'array'
          then p.work->'shipments' else '[]'::jsonb end) shipment
        where nullif(shipment->>'confirmationId', '') is not null
          and shipment->>'status' in ('DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED')
          and case when jsonb_typeof(shipment->'received'->f.sku) = 'number'
            then (shipment->'received'->>f.sku)::numeric >= 1 else false end
      )
    returning i.id
  )
  update app.fba_inbound_items f set published_at = now(), released_at = now()
  from verified v where f.plan_id = p_plan and f.item_id = v.id;
  get diagnostics published_count = row_count;
  return published_count;
end $$;

revoke all on function app.publish_fba_inbound_items(uuid, uuid[]) from public, anon, authenticated;
grant execute on function app.publish_fba_inbound_items(uuid, uuid[]) to service_role;
notify pgrst, 'reload schema';
