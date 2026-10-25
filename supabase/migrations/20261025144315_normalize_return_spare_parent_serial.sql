-- Preserve explicit parent links when registering an Amazon-return spare with a new body.
create or replace function app.enforce_amazon_return_main_item()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
  parent_id uuid;
  parent_count integer := 0;
  numeric_serial text;
  separator_and_tail text;
  parent_serial text;
  existing_depth integer;
  requested_depth integer;
  next_depth integer;
begin
  if new.marketplace::text <> 'Amazon返品' then return new; end if;

  if tg_op <> 'INSERT' then
    if new.amazon_returned_on is not null then new.is_accessory := false; end if;
    return new;
  end if;

  if new.is_accessory and new.work_stream::text = '付属品'
     and auth.uid() is not null and app.current_role() in ('admin','purchaser') then
    -- Resolve by the strongest available identity first. Numeric lot alone is used
    -- only when it identifies exactly one main item.
    if new.parent_item_id is not null then
      select p.id into parent_id from app.items p
       where p.id = new.parent_item_id and not p.is_accessory and p.lot_seq = new.lot_seq;
      if parent_id is null then
        raise exception '指定した本体が見つかりません。通番号を確認してください' using errcode='22023';
      end if;
      -- An explicit, validated parent is already exactly one match.
      parent_count := 1;
    end if;
    if parent_id is null and new.product_id is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.product_id = new.product_id;
    end if;
    if parent_id is null and nullif(new.marketplace_item_id,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_item_id = new.marketplace_item_id;
    end if;
    if parent_id is null and nullif(new.marketplace_url,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.marketplace_url = new.marketplace_url;
    end if;
    if parent_id is null and nullif(new.asin,'') is not null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq
         and p.asin = new.asin and p.title = new.title;
    end if;
    if parent_id is null then
      select count(*), (array_agg(p.id))[1] into parent_count, parent_id
       from app.items p
       where not p.is_accessory and p.lot_seq = new.lot_seq;
    end if;
    if parent_count <> 1 or parent_id is null then
      raise exception '同じ通番号の本体を一意に特定できません。商品ID・ASIN・仕入先URLを確認してください' using errcode='22023';
    end if;
    select * into parent from app.items p where p.id = parent_id for update;
    new.parent_item_id := parent.id;
    new.marketplace_item_id := coalesce(new.marketplace_item_id, parent.marketplace_item_id);
    new.marketplace_url := coalesce(new.marketplace_url, parent.marketplace_url);
    new.product_id := coalesce(new.product_id, parent.product_id);
    new.asin := coalesce(new.asin, parent.asin);
    parent_serial := lower(app.product_serial(parent.sku, parent.lot_seq));
  else
    new.is_accessory := false;
  end if;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if parent_serial is null then parent_serial := numeric_serial; end if;
  if separator_and_tail is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended('amazon-return:'||new.lot_seq::text||':'||coalesce(parent_serial,numeric_serial),179049));

  select coalesce(max(
      case when lower(app.product_serial(i.sku,i.lot_seq)) like parent_serial || '%'
           then length(app.product_serial(i.sku,i.lot_seq))-length(parent_serial) else 0 end
    ),0)
    into existing_depth
  from app.items i
  where i.lot_seq = new.lot_seq
    and i.marketplace::text = 'Amazon返品'
    and i.id <> coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid);

  requested_depth := length(coalesce((regexp_match(new.sku,'^[0-9]+([a-z]*)[-_]'))[1],''));
  next_depth := greatest(existing_depth + 1, requested_depth, 1);
  if new.is_accessory and parent_id is not null then
    new.sku := parent_serial || repeat('a', next_depth) || separator_and_tail;
  else
    new.sku := numeric_serial || repeat('a', next_depth) || separator_and_tail;
  end if;
  return new;
end;
$$;
