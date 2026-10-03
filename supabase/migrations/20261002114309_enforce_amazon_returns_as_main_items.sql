-- Amazon return rows represent returned main products, never attached accessories.
-- Fix existing classifications first so the return SKU sequence sees every row.
update app.items
set is_accessory = false, updated_at = now()
where marketplace::text = 'Amazon返品' and is_accessory
  and (status::text = 'Amazon返品' or amazon_returned_on is not null);

-- Legacy/imported rows can contain multiple physical returns with the same serial
-- suffix (for example 2055a twice). Keep the oldest serial and give each later
-- collision the next suffix, preserving the rest of its SKU and its row history.
do $$
declare
  collision record;
  candidate_depth integer;
  candidate_sku text;
begin
  for collision in
    with returned_items as (
      select i.id, i.sku, i.lot_seq,
        app.product_serial(i.sku, i.lot_seq) as serial_key,
        (regexp_match(i.sku, '^([0-9]+)'))[1] as numeric_serial,
        length(coalesce((regexp_match(i.sku, '^[0-9]+([a-z]*)[-_]'))[1], '')) as suffix_depth,
        i.created_at, i.amazon_returned_on, i.returned_on
      from app.items i
      where i.marketplace::text = 'Amazon返品'
        and (i.status::text = 'Amazon返品' or i.amazon_returned_on is not null)
    ), ranked_collisions as (
      select r.*,
        row_number() over(partition by r.lot_seq, r.serial_key order by r.created_at, r.amazon_returned_on nulls last, r.returned_on nulls last, r.id) as sequence_no,
        count(*) over(partition by r.lot_seq, r.serial_key) as collision_count
      from returned_items r
    )
    select * from ranked_collisions where collision_count > 1 and sequence_no > 1
    order by lot_seq, numeric_serial, sequence_no
  loop
    candidate_depth := greatest(collision.suffix_depth + 1, 1);
    loop
      candidate_sku := collision.numeric_serial || repeat('a', candidate_depth)
        || substring(collision.sku from '^[0-9]+[a-z]*([-_].*)$');
      exit when not exists (
        select 1 from app.items other
        where other.id <> collision.id and not other.is_accessory
          and app.product_serial(other.sku, other.lot_seq)
            = collision.numeric_serial || repeat('a', candidate_depth)
      );
      candidate_depth := candidate_depth + 1;
    end loop;
    update app.items set sku = candidate_sku, updated_at = now() where id = collision.id;
  end loop;
end;
$$;

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

revoke all on function app.enforce_amazon_return_main_item() from public, anon, authenticated;
drop trigger if exists items_enforce_amazon_return_main_item on app.items;
create trigger items_enforce_amazon_return_main_item
before insert or update of marketplace, is_accessory on app.items
for each row execute function app.enforce_amazon_return_main_item();

notify pgrst, 'reload schema';
