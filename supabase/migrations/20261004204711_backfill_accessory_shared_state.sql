-- Align historical accessory rows with their unique main item, keeping both rows separate.
drop trigger if exists items_redirect_accessory_shared_edits on app.items;
with candidate_pairs as (
  select accessory.id as accessory_id, parent.id as parent_id
  from app.items accessory
  join app.items parent on not parent.is_accessory
    and parent.lot_seq=accessory.lot_seq
    and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(accessory.sku,accessory.lot_seq)
  where accessory.is_accessory
), unique_pairs as (
  select accessory_id,(array_agg(parent_id))[1] as parent_id
  from candidate_pairs group by accessory_id having count(*)=1
)
update app.items accessory set
  status=parent.status,
  packed_on=parent.packed_on,
  shipped_on=parent.shipped_on,
  sales_channel=parent.sales_channel,
  sold_on=parent.sold_on,
  sold_price=null,
  payout_amount=null
from unique_pairs pair
join app.items parent on parent.id=pair.parent_id
where accessory.id=pair.accessory_id;
create trigger items_redirect_accessory_shared_edits
before update of status,packed_on,shipped_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.redirect_accessory_shared_edits();

-- Do not guess which main item to display when there are duplicate candidates.
create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel,sold_price bigint,payout_amount bigint)
language plpgsql stable security definer set search_path = '' as $$
declare target app.items%rowtype; source app.items%rowtype; parent_count integer;
begin
  target:=app.assert_can_work_on(p_item_id);
  if target.is_accessory then
    select count(*) into parent_count from app.items parent
    where not parent.is_accessory and parent.lot_seq=target.lot_seq
      and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq);
    if parent_count=1 then
      select parent.* into source from app.items parent
      where not parent.is_accessory and parent.lot_seq=target.lot_seq
        and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq);
      return query select source.sales_channel,source.sold_price,source.payout_amount;
      return;
    end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;
revoke all on function app.shared_product_sale_values(uuid) from public,anon;
grant execute on function app.shared_product_sale_values(uuid) to authenticated;
notify pgrst,'reload schema';