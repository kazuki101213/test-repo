-- Keep returned items eligible for a new sale without weakening duplicate-sale
-- protection for items whose supplier is NULL.
create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then
    return new;
  end if;
  if new.sold_on is null
     or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then
    return new;
  end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id
      and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null
      and i.returned_on is null
      and i.marketplace is distinct from 'Amazon返品'
      and i.status not in ('Amazon返品','返品処理','廃棄')
  ) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;
