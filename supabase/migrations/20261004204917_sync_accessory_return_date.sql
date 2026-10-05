-- Returned date drives the 返品処理 status, so it must follow the main item too.
drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create or replace function app.redirect_accessory_shared_edits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent app.items%rowtype; parent_count integer;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.returned_on is distinct from old.returned_on
    or new.sales_channel is distinct from old.sales_channel or new.sold_on is distinct from old.sold_on
    or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount
  ) then return new; end if;
  select count(*) into parent_count from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  if parent_count <> 1 then raise exception '対応する本体を一意に特定できません。通番号とSKUを確認してください'; end if;
  select i.* into parent from app.items i
   where not i.is_accessory and i.lot_seq=new.lot_seq
     and app.product_serial(i.sku,i.lot_seq)=app.product_serial(new.sku,new.lot_seq)
   for update;
  update app.items i set
    status=case when new.status is distinct from old.status then new.status else parent.status end,
    packed_on=case when new.packed_on is distinct from old.packed_on then new.packed_on else parent.packed_on end,
    shipped_on=case when new.shipped_on is distinct from old.shipped_on then new.shipped_on else parent.shipped_on end,
    returned_on=case when new.returned_on is distinct from old.returned_on then new.returned_on else parent.returned_on end,
    sales_channel=case when new.sales_channel is distinct from old.sales_channel then new.sales_channel else parent.sales_channel end,
    sold_on=case when new.sold_on is distinct from old.sold_on then new.sold_on else parent.sold_on end,
    sold_price=case when new.sold_price is distinct from old.sold_price then new.sold_price else parent.sold_price end,
    payout_amount=case when new.payout_amount is distinct from old.payout_amount then new.payout_amount else parent.payout_amount end
  where i.id=parent.id;
  select i.* into parent from app.items i where i.id=parent.id;
  new.status:=parent.status;
  new.packed_on:=parent.packed_on;
  new.shipped_on:=parent.shipped_on;
  new.returned_on:=parent.returned_on;
  new.sales_channel:=parent.sales_channel;
  new.sold_on:=parent.sold_on;
  new.sold_price:=null;
  new.payout_amount:=null;
  return new;
end;
$$;

-- Backfill the same fields on uniquely matched historical accessory rows.
with candidate_pairs as (
  select accessory.id as accessory_id,parent.id as parent_id
  from app.items accessory join app.items parent on not parent.is_accessory
    and parent.lot_seq=accessory.lot_seq
    and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(accessory.sku,accessory.lot_seq)
  where accessory.is_accessory
), unique_pairs as (
  select accessory_id,(array_agg(parent_id))[1] as parent_id
  from candidate_pairs group by accessory_id having count(*)=1
)
update app.items accessory set
  status=parent.status,packed_on=parent.packed_on,shipped_on=parent.shipped_on,
  returned_on=parent.returned_on,sales_channel=parent.sales_channel,sold_on=parent.sold_on,
  sold_price=null,payout_amount=null
from unique_pairs pair join app.items parent on parent.id=pair.parent_id
where accessory.id=pair.accessory_id;
create trigger items_redirect_accessory_shared_edits
before update of status,packed_on,shipped_on,returned_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.redirect_accessory_shared_edits();

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
     or new.shipped_on is distinct from old.shipped_on or new.returned_on is distinct from old.returned_on
     or new.sales_channel is distinct from old.sales_channel or new.sold_on is distinct from old.sold_on
     or new.sold_price is distinct from old.sold_price or new.payout_amount is distinct from old.payout_amount then
    update app.items accessory set status=new.status,packed_on=new.packed_on,shipped_on=new.shipped_on,
      returned_on=new.returned_on,sales_channel=new.sales_channel,sold_on=new.sold_on,
      sold_price=null,payout_amount=null
    where accessory.is_accessory and accessory.lot_seq=new.lot_seq
      and app.product_serial(accessory.sku,accessory.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  end if;
  return new;
end;
$$;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after update of status,packed_on,shipped_on,returned_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.sync_accessory_sale_date();
notify pgrst,'reload schema';