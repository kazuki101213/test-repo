-- Keep separate purchase rows while sharing the main product's work and sale.
-- Revenue remains on the main row only, preventing double-counted sales.
create or replace function app.inherit_accessory_inventory_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent app.items; parent_ids uuid[];
begin
  if not new.is_accessory then return new; end if;
  select array_agg(i.id) into parent_ids
  from app.items i
  where not i.is_accessory and i.id <> new.id and i.lot_seq = new.lot_seq
    and app.product_serial(i.sku,i.lot_seq) = app.product_serial(new.sku,new.lot_seq);
  -- Do not guess when imported data has an ambiguous or missing parent.
  if coalesce(array_length(parent_ids,1),0) <> 1 then return new; end if;
  select * into parent from app.items where id = parent_ids[1];
  new.status := parent.status;
  new.condition := parent.condition;
  new.sales_channel := parent.sales_channel;
  new.planned_price := parent.planned_price;
  new.planned_payout := parent.planned_payout;
  new.sold_on := parent.sold_on;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.product_registered_at := parent.product_registered_at;
  new.inspected_at := parent.inspected_at;
  new.cleaned_at := parent.cleaned_at;
  new.photo_uploaded_at := parent.photo_uploaded_at;
  new.listed_on := parent.listed_on;
  new.sold_price := null;
  new.payout_amount := null;
  return new;
end;
$$;
revoke all on function app.inherit_accessory_inventory_fields() from public,anon,authenticated;

-- Run after status derivation and SKU normalization, so those triggers cannot
-- give an accessory a different effective status from its main product.
create trigger items_zz_inherit_accessory_inventory_fields
before insert or update on app.items
for each row execute function app.inherit_accessory_inventory_fields();

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_accessory then return new; end if;
  if (select count(*) from app.items i where not i.is_accessory and i.lot_seq = new.lot_seq
      and app.product_serial(i.sku,i.lot_seq) = app.product_serial(new.sku,new.lot_seq)) <> 1 then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if row(new.status, new.condition, new.sales_channel, new.planned_price, new.planned_payout, new.sold_on, new.packed_on, new.shipped_on, new.product_registered_at, new.inspected_at, new.cleaned_at, new.photo_uploaded_at, new.listed_on,new.sku,new.lot_seq,new.is_accessory)
       is not distinct from row(old.status, old.condition, old.sales_channel, old.planned_price, old.planned_payout, old.sold_on, old.packed_on, old.shipped_on, old.product_registered_at, old.inspected_at, old.cleaned_at, old.photo_uploaded_at, old.listed_on,old.sku,old.lot_seq,old.is_accessory) then
      return new;
    end if;
  end if;
  update app.items accessory
  set status = new.status,
      condition = new.condition,
      sales_channel = new.sales_channel,
      planned_price = new.planned_price,
      planned_payout = new.planned_payout,
      sold_on = new.sold_on,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      product_registered_at = new.product_registered_at,
      inspected_at = new.inspected_at,
      cleaned_at = new.cleaned_at,
      photo_uploaded_at = new.photo_uploaded_at,
      listed_on = new.listed_on,
      sold_price = null, payout_amount = null
  where accessory.is_accessory and accessory.lot_seq = new.lot_seq
    and app.product_serial(accessory.sku,accessory.lot_seq) = app.product_serial(new.sku,new.lot_seq)
    and (row(accessory.status, accessory.condition, accessory.sales_channel, accessory.planned_price, accessory.planned_payout, accessory.sold_on, accessory.packed_on, accessory.shipped_on, accessory.product_registered_at, accessory.inspected_at, accessory.cleaned_at, accessory.photo_uploaded_at, accessory.listed_on) is distinct from row(new.status, new.condition, new.sales_channel, new.planned_price, new.planned_payout, new.sold_on, new.packed_on, new.shipped_on, new.product_registered_at, new.inspected_at, new.cleaned_at, new.photo_uploaded_at, new.listed_on)
         or accessory.sold_price is not null or accessory.payout_amount is not null);
  return new;
end;
$$;
revoke all on function app.sync_accessory_sale_date() from public,anon,authenticated;
drop trigger items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after insert or update on app.items
for each row execute function app.sync_accessory_sale_date();

-- Align existing accessories without changing their purchase details or SKUs.
with parents as (
  select lot_seq,app.product_serial(sku,lot_seq) as serial_key,min(id::text)::uuid as id
  from app.items where not is_accessory
  group by lot_seq,app.product_serial(sku,lot_seq) having count(*) = 1
)
update app.items accessory set status = parent.status
from parents p join app.items parent on parent.id = p.id
where accessory.is_accessory and accessory.lot_seq = p.lot_seq
  and app.product_serial(accessory.sku,accessory.lot_seq) = p.serial_key;

notify pgrst,'reload schema';
