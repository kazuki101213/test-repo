-- A date-only correction must not take over another product's historical SKU.
-- Retain the existing SKU in that narrow case; all other identity collision checks remain.
create or replace function app.sync_sku_from_item_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
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
end $$;
