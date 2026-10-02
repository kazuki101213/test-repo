-- Mirror a main item's sale date onto its attached accessories while keeping
-- accessory sale amounts empty to avoid double-counting revenue.
update app.items accessory
set sold_on = parent.sold_on, sold_price = null, payout_amount = null
from app.items parent
where accessory.is_accessory
  and not parent.is_accessory
  and accessory.lot_seq = parent.lot_seq
  and app.product_serial(accessory.sku, accessory.lot_seq) = app.product_serial(parent.sku, parent.lot_seq);

update app.items item set asin=product.asin
from app.products product
where item.product_id=product.id and item.asin is distinct from product.asin;

-- Inventory reimbursements are separate from buyer refunds in the UI.
alter table app.items add column if not exists inventory_refund_amount bigint not null default 0 check (inventory_refund_amount >= 0);

create or replace function app.keep_accessory_sale_amounts_empty()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_accessory then
    new.sold_price := null;
    new.payout_amount := null;
  end if;
  return new;
end;
$$;
revoke all on function app.keep_accessory_sale_amounts_empty() from public, anon, authenticated;
drop trigger if exists items_keep_accessory_sale_amounts_empty on app.items;
create trigger items_keep_accessory_sale_amounts_empty
before insert or update of is_accessory, sold_price, payout_amount on app.items
for each row execute function app.keep_accessory_sale_amounts_empty();

-- Accessory sale dates are informational; they must not mark an accessory as
-- sold because accessories intentionally keep sold_price empty.
create or replace function app.items_mark_sold()
returns trigger language plpgsql as $$
begin
  if new.sold_on is not null
     and not new.is_accessory
     and new.status <> '返品処理'
     and new.amazon_returned_on is null then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then
    new.status := '返品処理';
  end if;
  return new;
end;
$$;

create or replace function app.sync_accessory_sale_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.is_accessory and (new.sold_on is distinct from old.sold_on
      or new.sold_price is distinct from old.sold_price
      or new.payout_amount is distinct from old.payout_amount) then
    update app.items accessory
       set sold_on = new.sold_on, sold_price = null, payout_amount = null
     where accessory.is_accessory
       and accessory.lot_seq = new.lot_seq
       and app.product_serial(accessory.sku, accessory.lot_seq) = app.product_serial(new.sku, new.lot_seq);
  end if;
  return new;
end;
$$;
revoke all on function app.sync_accessory_sale_date() from public, anon, authenticated;
drop trigger if exists items_sync_accessory_sale_date on app.items;
create trigger items_sync_accessory_sale_date
after update of sold_on, sold_price, payout_amount on app.items
for each row execute function app.sync_accessory_sale_date();

create or replace function app.sync_inventory_shared_product_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.asin is distinct from old.asin then
    update app.items sibling set asin=new.asin
     where sibling.id<>new.id and sibling.product_id=new.product_id and new.product_id is not null
       and sibling.asin is distinct from new.asin;
    update app.items sibling set asin=new.asin
     where sibling.id<>new.id and new.product_id is null
       and app.product_serial(sibling.sku,sibling.lot_seq)=app.product_serial(new.sku,new.lot_seq)
       and sibling.asin is distinct from new.asin;
  end if;
  if new.planned_price is distinct from old.planned_price or new.planned_payout is distinct from old.planned_payout then
    update app.items sibling set planned_price=new.planned_price, planned_payout=new.planned_payout
     where sibling.id<>new.id
       and app.product_serial(sibling.sku,sibling.lot_seq)=app.product_serial(new.sku,new.lot_seq)
       and (sibling.planned_price is distinct from new.planned_price or sibling.planned_payout is distinct from new.planned_payout);
  end if;
  return new;
end;
$$;
revoke all on function app.sync_inventory_shared_product_fields() from public, anon, authenticated;
drop trigger if exists items_sync_inventory_shared_product_fields on app.items;
create trigger items_sync_inventory_shared_product_fields
after update of asin, planned_price, planned_payout on app.items
for each row execute function app.sync_inventory_shared_product_fields();

create or replace function app.sync_product_asin_to_inventory()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.asin is distinct from old.asin then
    update app.items set asin=new.asin where product_id=new.id and asin is distinct from new.asin;
  end if;
  return new;
end;
$$;
revoke all on function app.sync_product_asin_to_inventory() from public, anon, authenticated;
drop trigger if exists products_sync_asin_to_inventory on app.products;
create trigger products_sync_asin_to_inventory
after update of asin on app.products
for each row execute function app.sync_product_asin_to_inventory();

create or replace view app.v_inventory_display with (security_invoker = true) as
select inventory.*, raw.product_id, product.product_no, product.image_url as amazon_image_url,
  raw.amazon_refund_amount, raw.non_amazon_refund_amount, latest.body as latest_comment,
  case when not inventory.product_sale_conflict and inventory.product_sold_on is not null
      and inventory.product_payout_amount is not null
    then inventory.product_payout_amount + totals.refunds + totals.inventory_refunds - inventory.product_cost
      - totals.shipping - totals.other_cost end as product_profit,
  raw.inventory_refund_amount
from app.v_inventory_items inventory
join app.items raw on raw.id=inventory.id
left join app.products product on product.id=raw.product_id
left join lateral (select body from app.item_comments where item_id=inventory.id order by created_at desc,id desc limit 1) latest on true
left join lateral (
  select sum(refund_amount) as refunds, sum(inventory_refund_amount) as inventory_refunds,
    sum(shipping_cost) as shipping, sum(other_cost) as other_cost
  from app.items where app.product_serial(sku,lot_seq)=app.product_serial(raw.sku,raw.lot_seq)
) totals on true;
grant select on app.v_inventory_display to authenticated;

create or replace function app.guard_single_product_sale()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare serial_key text;
begin
  if TG_OP='UPDATE' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null or (new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0) then return new; end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists(select 1 from app.items i where app.product_serial(i.sku,i.lot_seq)=serial_key and i.id<>new.id
      and i.sold_on is not null and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and i.amazon_returned_on is null and i.returned_on is null and i.status not in ('Amazon返品','返品処理','廃棄')) then
    raise exception '同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。';
  end if;
  return new;
end; $$;
revoke all on function app.guard_single_product_sale() from public,anon,authenticated;

-- Only the active 長部一輝 delivery account bypasses photo review for pack/ship.
create or replace function app.is_delivery_master()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from app.profiles p join app.staff s on s.id = p.staff_id
    where p.user_id = auth.uid() and s.name = '長部一輝' and s.is_active and s.role = 'admin'
  );
$$;
revoke all on function app.is_delivery_master() from public, anon;
grant execute on function app.is_delivery_master() to authenticated;

create or replace function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 if p_done and p_step in ('packed','shipped') and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;

create or replace function app.require_photo_review(p_item_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if app.photo_review_enforced() and not app.is_delivery_master()
     and not exists (select 1 from app.photo_reviews where item_id=p_item_id and approved_at is not null) then
    raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
  end if;
end $$;

-- Keep previous sales intact. When Amazon sends the original numeric SKU after
-- a return, apply the new sale to the most recently created returned suffix row.
create or replace function app.apply_amazon_sale(
  p_account text,p_transaction text,p_sku text,p_asin text,p_sold_on date,p_price bigint,p_payout bigint,p_actor uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inventory app.items%rowtype; previous app.amazon_sale_matches%rowtype; evidence jsonb;
  target_id uuid; target_count integer; serial_key text; root_serial text;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
  if p_sold_on is null or p_sold_on>(now() at time zone 'Asia/Tokyo')::date or p_price is null or p_payout is null or p_price<0 or p_payout<0 then raise exception 'Invalid sale'; end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
   where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528' and t.transaction_type='Shipment' and t.status='RELEASED';
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku)<>1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY' and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  serial_key:=app.product_serial(p_sku,null);
  root_serial:=(regexp_match(p_sku,'^([0-9]+)'))[1];
  if serial_key is null then return jsonb_build_object('status','review','reason','SKUの商品番号を読み取れません。'); end if;
  -- Any returned row wins over the original SKU, even when Amazon reports only
  -- the numeric SKU. Suffix depth orders 100, 100a, 100aa chronologically.
  select id into target_id from app.items
   where not is_accessory and (regexp_match(sku,'^([0-9]+)'))[1]=root_serial
     and (amazon_returned_on is not null or returned_on is not null or status in ('Amazon返品','返品処理'))
   order by length(regexp_replace(app.product_serial(sku,lot_seq),'^[0-9]+','')) desc,
            coalesce(amazon_returned_on,returned_on) desc nulls last, updated_at desc, id desc
   limit 1;
  if target_id is null then
    select id into target_id from app.items where sku=p_sku and not is_accessory order by id limit 1;
  end if;
  if target_id is null then
    select count(*),min(id::text)::uuid into target_count,target_id from app.items
      where app.product_serial(sku,lot_seq)=serial_key and not is_accessory;
    if target_count<>1 then target_id:=null; end if;
  end if;
  if target_id is null then return jsonb_build_object('status','review','reason','一致するSKU・返品在庫が見つかりません。'); end if;
  select * into inventory from app.items where id=target_id for update;
  serial_key:=app.product_serial(inventory.sku,inventory.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。'); end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。'); end if;
  if inventory.status in ('廃棄') or (inventory.purchased_at is not null and inventory.purchased_at>p_sold_on) then return jsonb_build_object('status','review','reason','廃棄、または仕入日より前の販売のため確認が必要です。'); end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。'); end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price or inventory.payout_amount is distinct from previous.payout_amount then return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。'); end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。'); end if;
  elsif inventory.sold_on is not null or inventory.sold_price is not null or inventory.payout_amount is not null then
    return jsonb_build_object('status','review','reason','対象の返品行に既存の販売記録があります。上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout,status='販売済' where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by) values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
   on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を返品後の在庫行に反映しました。','item_id',inventory.id);
end; $$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;

-- Keep refund/reimbursement transaction provenance idempotent per exact Amazon
-- transaction and SKU; repeated imports adjust only that transaction's delta.
create table app.amazon_refund_matches (
  account_key text not null,
  marketplace_id text not null,
  transaction_id text not null,
  sku text not null,
  item_id uuid not null references app.items(id),
  refund_kind text not null check (refund_kind in ('inventory','amazon_refund')),
  amount bigint not null check (amount >= 0),
  applied_by uuid not null references auth.users(id),
  applied_at timestamptz not null default now(),
  primary key(account_key,marketplace_id,transaction_id,sku)
);
alter table app.amazon_refund_matches enable row level security;
revoke all on app.amazon_refund_matches from public,anon,authenticated;
grant select,insert,update on app.amazon_refund_matches to service_role;

create or replace function app.apply_amazon_refund(p_account text,p_transaction text,p_sku text,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare txn app.amazon_payment_transactions%rowtype; kind text; amount_value bigint; target app.items%rowtype; prior app.amazon_refund_matches%rowtype; delta bigint;
begin
 if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id where p.user_id=p_actor and s.role='admin' and s.is_active) then raise exception 'Administrator required'; end if;
 select * into txn from app.amazon_payment_transactions where account_key=p_account and marketplace_id='A1VC38T7YXB528' and transaction_id=p_transaction;
 if not found or txn.status <> 'RELEASED' then return jsonb_build_object('status','review','reason','支払い実行済みのAmazon取引が見つかりません。'); end if;
 kind:=case when lower(coalesce(txn.transaction_type,'')) in ('inventory reimbursement','inventoryreimbursement','fba inventory reimbursement','fbainventoryreimbursement','fba_inventory_reimbursement') then 'inventory'
            when lower(coalesce(txn.transaction_type,''))='refund' then 'amazon_refund' else null end;
 if kind is null then return jsonb_build_object('status','review','reason','対象外の取引種類です。'); end if;
 if (select count(*) from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku)<>1 then return jsonb_build_object('status','review','reason','SKUを取引内で一意に特定できません。'); end if;
 select abs((e->>'amount')::numeric)::bigint into amount_value from jsonb_array_elements(txn.item_breakdowns) e where e->>'sku'=p_sku and e->>'currency'='JPY' and e->>'amount' ~ '^-?[0-9]+(\.0+)?$';
 if amount_value is null then return jsonb_build_object('status','review','reason','SKU別の返金額が円の整数として確認できません。'); end if;
 select * into target from app.items where sku=p_sku and not is_accessory for update;
 if not found then return jsonb_build_object('status','review','reason','SKUが在庫一覧にありません。'); end if;
 select * into prior from app.amazon_refund_matches where account_key=p_account and marketplace_id=txn.marketplace_id and transaction_id=p_transaction and sku=p_sku;
 delta:=amount_value-coalesce(prior.amount,0);
 if delta<>0 then
   if kind='inventory' then update app.items set inventory_refund_amount=greatest(inventory_refund_amount+delta,0) where id=target.id;
   else update app.items set amazon_refund_amount=greatest(amazon_refund_amount+delta,0) where id=target.id;
   end if;
 end if;
 insert into app.amazon_refund_matches(account_key,marketplace_id,transaction_id,sku,item_id,refund_kind,amount,applied_by)
 values(p_account,txn.marketplace_id,p_transaction,p_sku,target.id,kind,amount_value,p_actor)
 on conflict(account_key,marketplace_id,transaction_id,sku) do update set item_id=excluded.item_id,refund_kind=excluded.refund_kind,amount=excluded.amount,applied_by=excluded.applied_by,applied_at=now();
 return jsonb_build_object('status',case when prior.amount is null then 'applied' when delta=0 then 'unchanged' else 'applied' end,'reason',case when kind='inventory' then '在庫の払い戻しを反映しました。' else 'Amazon返金金額を反映しました。' end,'amount',amount_value,'sku',p_sku);
end $$;
revoke all on function app.apply_amazon_refund(text,text,text,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_refund(text,text,text,uuid) to service_role;

notify pgrst, 'reload schema';
