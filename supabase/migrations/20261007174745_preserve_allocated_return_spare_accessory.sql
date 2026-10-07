create or replace function app.enforce_amazon_return_main_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  numeric_serial text;
  separator_and_tail text;
  requested_depth integer;
  existing_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then
    return new;
  end if;

  -- A reserve recovered from an Amazon return remains an accessory when
  -- registered together with its explicitly allocated main item. All source
  -- identity fields must match; ordinary return registrations stay main items.
  if tg_op = 'INSERT' and new.is_accessory and new.work_stream::text = '付属品'
    and auth.uid() is not null and app.current_role() in ('admin','purchaser')
    and exists (
      select 1 from app.spare_accessories s join app.items i on i.id=s.used_for_item_id
      where not i.is_accessory and i.lot_seq=new.lot_seq
        and i.created_by=app.current_staff_id()
        and i.deliverer_id is not distinct from new.deliverer_id
        and s.title is not distinct from new.title
        and s.marketplace_item_id is not distinct from new.marketplace_item_id
        and s.asin is not distinct from new.asin
        and s.cost_amount is not distinct from new.cost_amount
        and s.purchased_at is not distinct from new.purchased_at
        and new.purchaser_id is not distinct from coalesce(s.owner_staff_id,i.purchaser_id)
        and (app.is_admin() or s.owner_staff_id=app.current_staff_id())
    ) then return new; end if;

  if tg_op <> 'INSERT' then
    if new.status::text = 'Amazon返品' or new.amazon_returned_on is not null then
      new.is_accessory := false;
    end if;
    return new;
  end if;

  new.is_accessory := false;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if numeric_serial is null or separator_and_tail is null then
    return new;
  end if;

  -- Serialize return registrations for a product so concurrent submissions
  -- cannot receive the same suffix.
  perform pg_advisory_xact_lock(hashtextextended('amazon-return:' || new.lot_seq::text || ':' || numeric_serial, 179049));

  select coalesce(max(length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''))), 0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and (regexp_match(i.sku, '^([0-9]+)'))[1] = numeric_serial;

  requested_depth := length(coalesce((regexp_match(new.sku, '^[0-9]+([a-z]*)[-_]'))[1], ''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  return new;
end;
$$;
