-- Keep historical SKUs usable for scans, photographs and Amazon order matching.
create table app.item_sku_aliases (
  sku text primary key,
  item_id uuid not null references app.items(id) on delete cascade,
  changed_at timestamptz not null default now()
);
create index item_sku_aliases_item_idx on app.item_sku_aliases(item_id);
alter table app.item_sku_aliases enable row level security;
grant select on app.item_sku_aliases to authenticated;
create policy item_sku_aliases_read on app.item_sku_aliases for select to authenticated using (
  exists (select 1 from app.items i where i.id=item_id
    and (app.current_role() in ('admin','purchaser') or i.deliverer_id=app.current_staff_id()))
);

create function app.sync_sku_from_item_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare purchaser_code text; deliverer_code text; middle_code text; date_part text; suffix text;
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
    raise exception 'このSKUは別商品の旧SKUとして使われています' using errcode='23505';
  end if;
  return new;
end $$;
create trigger items_sync_sku_from_identity before update of lot_seq,purchaser_id,deliverer_id,purchased_at,cost_amount,sku
  on app.items for each row execute function app.sync_sku_from_item_identity();

create function app.record_item_sku_alias() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.sku is distinct from old.sku then
    insert into app.item_sku_aliases(sku,item_id) values(old.sku,new.id)
      on conflict (sku) do update set item_id=excluded.item_id,changed_at=now()
      where app.item_sku_aliases.item_id=excluded.item_id;
  end if;
  return new;
end $$;
create trigger items_record_sku_alias after update of sku on app.items
  for each row execute function app.record_item_sku_alias();

create or replace function app.find_by_sku(p_sku text) returns app.items
language sql stable security definer set search_path = '' as $$
  select i.* from app.items i
  where (i.sku=btrim(p_sku) or exists (select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=btrim(p_sku)))
    and (app.is_admin() or i.deliverer_id=app.current_staff_id())
  limit 1;
$$;

drop policy if exists "item photos are readable by staff in charge" on storage.objects;
create policy "item photos are readable by staff in charge" on storage.objects for select to authenticated
using (bucket_id='item-photos' and exists (
  select 1 from app.items i where
    (i.sku=split_part(name,'/',1) or exists (select 1 from app.item_sku_aliases a where a.item_id=i.id and a.sku=split_part(name,'/',1)))
    and (app.current_role() in ('admin','purchaser') or i.deliverer_id=app.current_staff_id())
));

-- Original catalogue numbers remain on app.products; v_inventory_display joins them by product_id.
create or replace view app.v_amazon_order_reconciliation with (security_invoker = true) as
with normalized as (
  select h.*,
    (h.ordered_at at time zone 'Asia/Tokyo')::date as order_on,
    case
      when h.sku ~ '^[A-Z]{2}-[0-9]+-[0-9]{8}-[0-9]+$'
        then split_part(h.sku,'-',2)||'-AA'||split_part(h.sku,'-',1)||'-'||split_part(h.sku,'-',3)||'-'||split_part(h.sku,'-',4)
      when h.sku ~ '^AA[A-Z]{2}-[0-9]+-[0-9]{8}-[0-9]+$'
        then split_part(h.sku,'-',2)||'-'||split_part(h.sku,'-',1)||'-'||split_part(h.sku,'-',3)||'-'||split_part(h.sku,'-',4)
      else h.sku
    end as canonical_sku
  from app.amazon_order_history h
), sku_links as (
  select sku,id as item_id from app.items
  union
  select sku,item_id from app.item_sku_aliases
), items_by_sku as (
  select l.sku, max(i.sold_on) as app_sold_on, max(i.sold_price) as app_sold_price,
    count(*) as app_row_count
  from sku_links l join app.items i on i.id=l.item_id group by l.sku
), matched as (
  select n.*, i.app_sold_on, i.app_sold_price, i.app_row_count,
    count(*) filter (where n.order_status in ('Shipped','Delivered','Shipped - Delivered to Buyer') and n.item_price is not null)
      over (partition by n.account_key,n.canonical_sku) as order_count_for_sku
  from normalized n left join items_by_sku i on i.sku=n.canonical_sku
)
select account_key,order_item_id,order_id,ordered_at,order_on,order_status,fulfillment_channel,
  sku,canonical_sku,asin,quantity,currency,item_price,item_tax,shipping_price,shipping_tax,
  promotion_discount,source_report,imported_at,app_sold_on,app_sold_price,app_row_count,
  order_count_for_sku,
  case
    when order_status not in ('Shipped','Delivered','Shipped - Delivered to Buyer') then '対象外'
    when item_price is null then '金額未確定'
    when quantity is distinct from 1 then '複数個'
    when app_row_count is null then '商品未登録'
    when order_count_for_sku > 1 then '同一SKU複数注文'
    when app_sold_on is null then 'アプリ未販売'
    when app_sold_price is distinct from item_price then '価格相違'
    when app_sold_on is distinct from order_on then '日付差'
    else '一致'
  end as reconciliation_status
from matched;
grant select on app.v_amazon_order_reconciliation to authenticated;

notify pgrst, 'reload schema';
