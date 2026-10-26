-- Return SKU tails identify the original purchase; the return's accounting cost stays unchanged.
create function app.return_sku_original_cost(p_sku text,p_lot integer) returns text
language plpgsql stable security definer set search_path='' as $$
declare matches integer; original_cost bigint;
begin
 if p_sku !~ '^[0-9]+[ab]+-[A-Z]{2,4}-[0-9]{8}-[0-9]+$' then return p_sku;end if;
 select count(*),min(i.cost_amount) into matches,original_cost from app.items i
 where not i.is_accessory and split_part(i.sku,'-',1)=p_lot::text;
 if matches<>1 then return p_sku;end if;
 return regexp_replace(p_sku,'-[0-9]+$','-'||(original_cost/10)::text);
end$$;
revoke all on function app.return_sku_original_cost(text,integer) from public,anon,authenticated;
CREATE OR REPLACE FUNCTION app.redirect_accessory_shared_edits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  parent app.items%rowtype; previous_redirect text;
begin
  -- A verified tail-only correction must not redirect unrelated accessory state.
  if new.sku is distinct from old.sku
     and regexp_replace(new.sku,'-[0-9]+$','')=regexp_replace(old.sku,'-[0-9]+$','')
     and to_jsonb(new)-'sku'-'updated_at'=to_jsonb(old)-'sku'-'updated_at'
     and new.sku=app.return_sku_original_cost(old.sku,old.lot_seq)
  then return new;end if;
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory
     or app.is_standalone_accessory_serial(old.sku,old.lot_seq) then return new; end if;
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

  previous_redirect:=current_setting('app.redirecting_accessory_id',true);
  perform set_config('app.redirecting_accessory_id',old.id::text,true);
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

  perform set_config('app.redirecting_accessory_id',coalesce(previous_redirect,''),true);
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
$function$
;
CREATE OR REPLACE FUNCTION app.sync_sku_from_item_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare purchaser_code text; deliverer_code text; middle_code text; date_part text; suffix text;
  purchase_date_only boolean := new.purchased_at is distinct from old.purchased_at
    and new.lot_seq is not distinct from old.lot_seq
    and new.purchaser_id is not distinct from old.purchaser_id
    and new.deliverer_id is not distinct from old.deliverer_id
    and new.cost_amount is not distinct from old.cost_amount
    and new.sku is not distinct from old.sku;
begin
  if new.lot_seq is distinct from old.lot_seq
      or new.purchaser_id is distinct from old.purchaser_id
      or new.deliverer_id is distinct from old.deliverer_id
      or new.purchased_at is distinct from old.purchased_at
      or new.cost_amount is distinct from old.cost_amount then
    select code into purchaser_code from app.staff where id=new.purchaser_id;
    select code into deliverer_code from app.staff where id=new.deliverer_id;
    middle_code := coalesce(purchaser_code,'') || coalesce(deliverer_code,'');
    if middle_code='' then middle_code:=split_part(old.sku,'-',2); end if;
    if length(middle_code) not in (2,4) then raise exception '担当者コードを確認してください' using errcode='22023'; end if;
    date_part := case when new.purchased_at is null then split_part(old.sku,'-',3)
                      else to_char(new.purchased_at,'YYYYMMDD') end;
    suffix := coalesce(substring(new.sku from '^[0-9]+([a-z]+)-'),
                       substring(old.sku from '^[0-9]+([a-z]+)-'), '');
    new.sku := new.lot_seq::text || suffix || '-' || middle_code || '-' || date_part || '-' || (new.cost_amount / 10)::bigint;
  end if;
  new.sku:=app.return_sku_original_cost(new.sku,new.lot_seq);
  if exists (select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then
    if purchase_date_only and not exists(
      select 1 from app.item_sku_aliases a where a.sku=old.sku and a.item_id<>new.id
    ) then
      new.sku:=old.sku;
    else
      raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';
    end if;
  end if;
  return new;
end $function$
;
create function app.normalize_return_sku_insert() returns trigger
language plpgsql security definer set search_path='pg_catalog','app' as $$
begin new.sku:=app.return_sku_original_cost(new.sku,new.lot_seq);
 if exists(select 1 from app.item_sku_aliases a where a.sku=new.sku and a.item_id<>new.id) then raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';end if;
 return new;end$$;
revoke all on function app.normalize_return_sku_insert() from public,anon,authenticated;
create trigger items_zzz_return_sku_original_cost before insert on app.items for each row execute function app.normalize_return_sku_insert();
drop trigger items_record_sku_alias on app.items;
create trigger items_record_sku_alias after update on app.items for each row when (old.sku is distinct from new.sku) execute function app.record_item_sku_alias();
CREATE OR REPLACE FUNCTION app.sync_accessory_sale_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  accessory app.items%rowtype;
begin
  if new.sku is distinct from old.sku
     and regexp_replace(new.sku,'-[0-9]+$','')=regexp_replace(old.sku,'-[0-9]+$','')
     and to_jsonb(new)-'sku'-'updated_at'=to_jsonb(old)-'sku'-'updated_at'
     and new.sku=app.return_sku_original_cost(old.sku,old.lot_seq)
  then return new;end if;
  if new.is_accessory then return new; end if;
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
    where a.id::text is distinct from nullif(current_setting('app.redirecting_accessory_id',true),'')
      and a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq) and (
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
$function$
;
