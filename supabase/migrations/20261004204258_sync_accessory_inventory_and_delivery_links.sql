-- Keep main and accessory rows separate while synchronizing shared work and sale fields.
create or replace function app.redirect_accessory_shared_edits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent app.items%rowtype; parent_count integer;
begin
  if pg_trigger_depth() > 1 or not old.is_accessory or not new.is_accessory then return new; end if;
  if not (
    new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
    or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
    or new.sold_on is distinct from old.sold_on or new.sold_price is distinct from old.sold_price
    or new.payout_amount is distinct from old.payout_amount
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
    sales_channel=case when new.sales_channel is distinct from old.sales_channel then new.sales_channel else parent.sales_channel end,
    sold_on=case when new.sold_on is distinct from old.sold_on then new.sold_on else parent.sold_on end,
    sold_price=case when new.sold_price is distinct from old.sold_price then new.sold_price else parent.sold_price end,
    payout_amount=case when new.payout_amount is distinct from old.payout_amount then new.payout_amount else parent.payout_amount end
  where i.id=parent.id;
  select i.* into parent from app.items i where i.id=parent.id;
  new.status:=parent.status;
  new.packed_on:=parent.packed_on;
  new.shipped_on:=parent.shipped_on;
  new.sales_channel:=parent.sales_channel;
  new.sold_on:=parent.sold_on;
  new.sold_price:=null;
  new.payout_amount:=null;
  return new;
end;
$$;
revoke all on function app.redirect_accessory_shared_edits() from public,anon,authenticated;
drop trigger if exists items_redirect_accessory_shared_edits on app.items;
create trigger items_redirect_accessory_shared_edits
before update of status,packed_on,shipped_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.redirect_accessory_shared_edits();

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 or new.is_accessory then return new; end if;
  if new.status is distinct from old.status or new.packed_on is distinct from old.packed_on
     or new.shipped_on is distinct from old.shipped_on or new.sales_channel is distinct from old.sales_channel
     or new.sold_on is distinct from old.sold_on or new.sold_price is distinct from old.sold_price
     or new.payout_amount is distinct from old.payout_amount then
    update app.items accessory set status=new.status,packed_on=new.packed_on,shipped_on=new.shipped_on,
      sales_channel=new.sales_channel,sold_on=new.sold_on,sold_price=null,payout_amount=null
    where accessory.is_accessory and accessory.lot_seq=new.lot_seq
      and app.product_serial(accessory.sku,accessory.lot_seq)=app.product_serial(new.sku,new.lot_seq);
  end if;
  return new;
end;
$$;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after update of status,packed_on,shipped_on,sales_channel,sold_on,sold_price,payout_amount on app.items
for each row execute function app.sync_accessory_sale_date();

create or replace function app.shared_product_sale_values(p_item_id uuid)
returns table(sales_channel app.sales_channel,sold_price bigint,payout_amount bigint)
language plpgsql stable security definer set search_path = '' as $$
declare target app.items%rowtype; source app.items%rowtype;
begin
  target:=app.assert_can_work_on(p_item_id);
  if target.is_accessory then
    select parent.* into source from app.items parent
    where not parent.is_accessory and parent.lot_seq=target.lot_seq
      and app.product_serial(parent.sku,parent.lot_seq)=app.product_serial(target.sku,target.lot_seq)
    order by parent.created_at,parent.id limit 1;
    if found then return query select source.sales_channel,source.sold_price,source.payout_amount; return; end if;
  end if;
  return query select target.sales_channel,target.sold_price,target.payout_amount;
end;
$$;
revoke all on function app.shared_product_sale_values(uuid) from public,anon;
grant execute on function app.shared_product_sale_values(uuid) to authenticated;
-- The delivery app reads the main row's actual price for both rows; accessory amounts stay NULL.
create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  case when i.is_accessory then shared.sales_channel else i.sales_channel end as sales_channel,
  i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,
  coalesce(nullif(btrim(p.image_url),''),nullif(btrim(asin_product.image_url),'')) as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at,
  case when i.is_accessory then shared.sold_price else i.sold_price end as sold_price,
  case when i.is_accessory then shared.payout_amount else i.payout_amount end as payout_amount,
  i.marketplace_url
from app.items i
left join app.products p on p.id=i.product_id
left join app.products asin_product on asin_product.asin=i.asin
left join app.staff buyer on buyer.id=i.purchaser_id
left join lateral app.shared_product_sale_values(i.id) shared on true
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;

-- Correct the staff segment from assigned staff records on insert or assignment changes.
create or replace function app.set_working_return_sku_staff_codes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare purchaser_code text; deliverer_code text; parts text[];
begin
  if new.marketplace::text <> '動作品Amazon返品' or new.sku is null then return new; end if;
  if tg_op='UPDATE' and new.marketplace is not distinct from old.marketplace
     and new.purchaser_id is not distinct from old.purchaser_id
     and new.deliverer_id is not distinct from old.deliverer_id then return new; end if;
  select s.code into purchaser_code from app.staff s where s.id=new.purchaser_id;
  select s.code into deliverer_code from app.staff s where s.id=new.deliverer_id;
  parts:=string_to_array(new.sku,'-');
  if array_length(parts,1) <> 4 or parts[2] !~ '^[A-Z]{2,4}$' then
    raise exception '動作品Amazon返品のSKU形式を確認してください';
  end if;
  if purchaser_code is null and deliverer_code is null then
    raise exception 'SKUを作成するには仕入担当者か納品担当者が必要です';
  end if;
  new.sku:=parts[1]||'-'||coalesce(purchaser_code,'')||coalesce(deliverer_code,'')||'-'||parts[3]||'-'||parts[4];
  return new;
end;
$$;
revoke all on function app.set_working_return_sku_staff_codes() from public,anon,authenticated;
drop trigger if exists items_set_working_return_sku_staff_codes on app.items;
create trigger items_set_working_return_sku_staff_codes
before insert or update of marketplace,purchaser_id,deliverer_id on app.items
for each row execute function app.set_working_return_sku_staff_codes();

-- Repair existing rows from the deliverer assigned on each inventory record.
update app.items i set sku=split_part(i.sku,'-',1)||'-'||left(split_part(i.sku,'-',2),2)||deliverer.code||'-'||split_part(i.sku,'-',3)||'-'||split_part(i.sku,'-',4)
from app.staff deliverer
where i.marketplace::text='動作品Amazon返品'
  and i.deliverer_id=deliverer.id
  and substring(split_part(i.sku,'-',2) from 3 for 2) is distinct from deliverer.code;

notify pgrst,'reload schema';