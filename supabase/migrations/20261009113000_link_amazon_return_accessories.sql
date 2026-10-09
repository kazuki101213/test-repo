-- Link accessories to one explicit main item and synchronize the shared inventory fields.
alter table app.items
  add column if not exists parent_item_id uuid references app.items(id) on delete restrict;

create index if not exists items_parent_item_id_idx on app.items(parent_item_id);

create or replace function app.accessory_sku_for_parent(p_parent_sku text, p_accessory_sku text)
returns text
language plpgsql immutable set search_path=''
as $$
declare
  parent_serial text := app.product_serial(p_parent_sku, null);
  accessory_serial text := app.product_serial(p_accessory_sku, null);
  parent_letters text := coalesce((regexp_match(parent_serial, '^[0-9]+([a-z]*)$'))[1], '');
  accessory_letters text := coalesce((regexp_match(accessory_serial, '^[0-9]+([a-z]*)$'))[1], '');
  suffix text;
  tail text := coalesce(substring(p_parent_sku from '[-_].*$'), substring(p_accessory_sku from '[-_].*$'));
begin
  if parent_serial is null then return p_parent_sku; end if;
  suffix := case
    when parent_letters <> '' and accessory_letters like parent_letters || '%' then substring(accessory_letters from length(parent_letters)+1)
    else accessory_letters
  end;
  if suffix = '' then suffix := 'a'; end if;
  return parent_serial || suffix || tail;
end;
$$;

create or replace function app.keep_accessory_sale_amounts_empty()
returns trigger
language plpgsql security definer set search_path=''
as $$
begin
  if new.is_accessory and not exists (
    select 1 from app.items p where p.id = new.parent_item_id and not p.is_accessory
  ) then
    new.sold_price := null;
    new.payout_amount := null;
  end if;
  return new;
end;
$$;

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
       where p.id = new.parent_item_id and not p.is_accessory;
      if parent_id is null then
        raise exception '指定した本体が見つかりません。通番号を確認してください' using errcode='22023';
      end if;
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
    parent_serial := app.product_serial(parent.sku, parent.lot_seq);
  else
    new.is_accessory := false;
  end if;

  numeric_serial := (regexp_match(new.sku, '^([0-9]+)'))[1];
  separator_and_tail := substring(new.sku from '^[0-9]+[a-z]*([-_].*)$');
  if parent_serial is null then parent_serial := numeric_serial; end if;
  if separator_and_tail is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended('amazon-return:'||new.lot_seq::text||':'||coalesce(parent_serial,numeric_serial),179049));

  select coalesce(max(
      case when app.product_serial(i.sku,i.lot_seq) like parent_serial || '%'
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

create or replace function app.link_accessory_parent_on_insert()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent_id uuid;
  parent_count integer;
begin
  if not new.is_accessory or new.parent_item_id is not null then return new; end if;
  select count(*), (array_agg(p.id))[1] into parent_count, parent_id
  from app.items p
  where not p.is_accessory and p.lot_seq = new.lot_seq
    and app.product_serial(p.sku,p.lot_seq) = app.product_serial(new.sku,new.lot_seq);
  if parent_count = 0 then
    select count(*), (array_agg(p.id))[1] into parent_count, parent_id
    from app.items p where not p.is_accessory and p.lot_seq = new.lot_seq;
  end if;
  if parent_count > 1 then
    raise exception '同じ通番号の本体が複数あるため、付属品を登録できません。SKUを確認してください' using errcode='22023';
  end if;
  if parent_count = 1 then new.parent_item_id := parent_id; end if;
  return new;
end;
$$;

drop trigger if exists items_link_accessory_parent_on_insert on app.items;
create trigger items_link_accessory_parent_on_insert
  before insert on app.items for each row
  execute function app.link_accessory_parent_on_insert();

create or replace function app.sync_accessory_sale_date()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  accessory app.items%rowtype;
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  for accessory in
    select a.* from app.items a
    where a.is_accessory and (
      a.parent_item_id = new.id
      or (a.parent_item_id is null and a.lot_seq = old.lot_seq
          and app.product_serial(a.sku,a.lot_seq) = app.product_serial(old.sku,old.lot_seq))
    )
    for update
  loop
    update app.items set
      parent_item_id = new.id,
      status = new.status,
      packed_on = new.packed_on,
      shipped_on = new.shipped_on,
      returned_on = new.returned_on,
      sales_channel = new.sales_channel,
      condition = new.condition,
      sold_on = new.sold_on,
      sold_price = new.sold_price,
      payout_amount = new.payout_amount,
      sku = app.accessory_sku_for_parent(new.sku, accessory.sku),
      lot_seq = new.lot_seq,
      deliverer_id = new.deliverer_id
    where id = accessory.id;
  end loop;
  return new;
end;
$$;

create or replace function app.redirect_accessory_shared_edits()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
  parent app.items%rowtype;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.condition is distinct from old.condition or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
    or new.sku is distinct from old.sku or new.lot_seq is distinct from old.lot_seq
    or new.deliverer_id is distinct from old.deliverer_id
  ) then return new; end if;

  select p.* into parent from app.items p
  where not p.is_accessory and (
    p.id = coalesce(new.parent_item_id, old.parent_item_id)
    or (new.parent_item_id is null and old.parent_item_id is null
        and p.lot_seq = old.lot_seq
        and app.product_serial(p.sku,p.lot_seq) = app.product_serial(old.sku,old.lot_seq))
  )
  order by (p.id = coalesce(new.parent_item_id, old.parent_item_id)) desc
  limit 1
  for update;

  if parent.id is null then
    raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください' using errcode='22023';
  end if;

  update app.items set
    status = new.status,
    packed_on = new.packed_on,
    shipped_on = new.shipped_on,
    returned_on = new.returned_on,
    sales_channel = new.sales_channel,
    condition = new.condition,
    sold_on = new.sold_on,
    sold_price = new.sold_price,
    payout_amount = new.payout_amount,
    lot_seq = new.lot_seq,
    deliverer_id = new.deliverer_id,
    sku = parent.sku
  where id = parent.id;

  select * into parent from app.items where id = parent.id;
  new.parent_item_id := parent.id;
  new.status := parent.status;
  new.packed_on := parent.packed_on;
  new.shipped_on := parent.shipped_on;
  new.returned_on := parent.returned_on;
  new.sales_channel := parent.sales_channel;
  new.condition := parent.condition;
  new.sold_on := parent.sold_on;
  new.sold_price := parent.sold_price;
  new.payout_amount := parent.payout_amount;
  new.lot_seq := parent.lot_seq;
  new.deliverer_id := parent.deliverer_id;
  new.sku := app.accessory_sku_for_parent(parent.sku, old.sku);
  return new;
end;
$$;

drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create trigger items_redirect_accessory_shared_edits
  before update of status,packed_on,shipped_on,returned_on,sales_channel,condition,sold_on,sold_price,payout_amount,sku,lot_seq,deliverer_id
  on app.items for each row execute function app.redirect_accessory_shared_edits();

drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
  after update of status,packed_on,shipped_on,sales_channel,condition,sold_on,sold_price,payout_amount,sku,lot_seq,deliverer_id
  on app.items for each row execute function app.sync_accessory_sale_date();

create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel, sold_price bigint, payout_amount bigint)
language plpgsql stable security definer set search_path=''
as $$
declare target app.items%rowtype;
declare source app.items%rowtype;
begin
  target := app.assert_can_work_on(p_item_id);
  if target.is_accessory then
    select parent.* into source from app.items parent
    where not parent.is_accessory and (
      parent.id = target.parent_item_id
      or (target.parent_item_id is null
          and parent.lot_seq = target.lot_seq
          and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq))
    )
    limit 1;
    if source.id is not null then
      return query select source.sales_channel,source.sold_price,source.payout_amount;
      return;
    end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;

create or replace function app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
returns jsonb
language plpgsql set search_path=''
as $$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
  v_parent_id uuid;
  v_parent_count integer;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text,179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) then
    select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
      from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq
        and app.product_serial(p.sku,p.lot_seq)=app.product_serial(v_input.sku,v_input.lot_seq);
    if v_parent_count=0 then
      select count(*),(array_agg(p.id))[1] into v_parent_count,v_parent_id
        from app.items p where not p.is_accessory and p.lot_seq=v_input.lot_seq;
    end if;
    if v_parent_count<>1 then
      raise exception 'この通番号の本体を一意に特定できません。本体を先に登録してください' using errcode='22023';
    end if;
    v_input.parent_item_id := v_parent_id;
  end if;
  insert into app.items (parent_item_id,sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id)
  values (v_input.parent_item_id,v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'作業中'::app.item_status),v_input.memo,v_input.source_purchase_draft_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (parent_item_id,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,product_id,sales_channel,memo)
    values (v_item.id,v_item.lot_seq,true,coalesce(v_spare.owner_staff_id,v_item.purchaser_id),v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
        then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end,
      v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.product_id,v_item.sales_channel,v_spare.usage_note)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$$;

notify pgrst, 'reload schema';
