-- An ASIN already in the catalogue identifies an existing product.
-- Relink the inventory row in the same update that saves its ASIN.
create function app.resolve_inventory_asin_product()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  matching_product uuid;
begin
  if coalesce(app.current_role() in ('admin','purchaser'), false) then
    if new.asin is null and old.asin is distinct from new.asin and new.product_id is not null then
      raise exception '商品リストに紐づく商品にはASINを入力してください。' using errcode = '22023';
    end if;
    if new.asin is not null then
      select id into matching_product from app.products where asin = new.asin for share;
      if found then
        new.product_id := matching_product;
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app.resolve_inventory_asin_product() from public, anon, authenticated;
create trigger items_resolve_inventory_asin_product
before update of asin on app.items
for each row execute function app.resolve_inventory_asin_product();

create or replace function app.sync_inventory_shared_product_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.asin is distinct from old.asin and new.product_id is not distinct from old.product_id then
    if new.product_id is null then
      update app.items sibling set asin = new.asin
       where sibling.id <> new.id and sibling.product_id is null
         and app.product_serial(sibling.sku,sibling.lot_seq) = app.product_serial(new.sku,new.lot_seq)
         and sibling.asin is distinct from new.asin;
    elsif app.current_role() in ('admin','purchaser') then
      -- A new ASIN for a linked product retains the catalogue-wide edit.
      -- The existing catalogue trigger then updates its linked inventory.
      begin
        update app.products set asin = new.asin
         where id = new.product_id and asin is distinct from new.asin;
      exception when unique_violation then
        raise exception '同じASINが先に登録されました。在庫を再読み込みして保存してください。' using errcode = '40001';
      end;
    else
      update app.items sibling set asin = new.asin
       where sibling.id <> new.id and sibling.product_id = new.product_id
         and sibling.asin is distinct from new.asin;
    end if;
  end if;
  if new.planned_price is distinct from old.planned_price or new.planned_payout is distinct from old.planned_payout then
    update app.items sibling set planned_price = new.planned_price, planned_payout = new.planned_payout
     where sibling.id <> new.id
       and app.product_serial(sibling.sku,sibling.lot_seq) = app.product_serial(new.sku,new.lot_seq)
       and (sibling.planned_price is distinct from new.planned_price or sibling.planned_payout is distinct from new.planned_payout);
  end if;
  return new;
end;
$$;
