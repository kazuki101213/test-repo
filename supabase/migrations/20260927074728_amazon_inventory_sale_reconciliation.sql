create table app.amazon_sale_matches (
  item_id uuid primary key references app.items(id),
  account_key text not null,
  transaction_id text not null,
  sku text not null,
  sold_on date not null,
  sold_price bigint not null check (sold_price >= 0),
  payout_amount bigint not null check (payout_amount >= 0),
  applied_by uuid not null references auth.users(id),
  applied_at timestamptz not null default now(),
  unique(account_key, transaction_id, sku)
);
alter table app.amazon_sale_matches enable row level security;
revoke all on app.amazon_sale_matches from public, anon, authenticated;
grant select, insert, update on app.amazon_sale_matches to service_role;
comment on table app.amazon_sale_matches is 'Exact-SKU Amazon sale reconciliation provenance. Does not store buyer details.';

create or replace function app.apply_amazon_sale(
  p_account text, p_transaction text, p_sku text, p_asin text,
  p_sold_on date, p_price bigint, p_payout bigint, p_actor uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  inventory app.items%rowtype;
  previous app.amazon_sale_matches%rowtype;
  evidence jsonb;
begin
  if not exists(select 1 from app.profiles p join app.staff s on s.id=p.staff_id
      where p.user_id=p_actor and s.role='admin' and s.is_active) then
    raise exception 'Administrator required';
  end if;
  if p_sold_on is null or p_sold_on > (now() at time zone 'Asia/Tokyo')::date
      or p_price is null or p_payout is null or p_price < 0 or p_payout < 0 then
    raise exception 'Invalid sale';
  end if;
  select t.item_breakdowns into evidence from app.amazon_payment_transactions t
    where t.account_key=p_account and t.transaction_id=p_transaction and t.marketplace_id='A1VC38T7YXB528'
      and t.transaction_type='Shipment' and t.status in ('RELEASED','DEFERRED_RELEASED');
  if evidence is null or (select count(*) from jsonb_array_elements(evidence) e where e->>'sku'=p_sku) <> 1
    or not exists(select 1 from jsonb_array_elements(evidence) e where e->>'sku'=p_sku and e->>'currency'='JPY'
        and (e->>'quantity')::numeric=1 and (e->>'amount')::numeric=p_payout) then
    return jsonb_build_object('status','review','reason','確定した商品別金額の根拠がありません。');
  end if;
  select * into inventory from app.items where sku=p_sku for update;
  if not found then return jsonb_build_object('status','review','reason','一致するSKUが在庫一覧にありません。'); end if;
  if inventory.asin is not null and p_asin is not null and inventory.asin<>p_asin then
    return jsonb_build_object('status','review','reason','在庫とAmazonのASINが一致しません。');
  end if;
  if inventory.sales_channel is not null and inventory.sales_channel not in ('FBA','自己発送') then
    return jsonb_build_object('status','review','reason','在庫の販売先がAmazon以外です。');
  end if;
  if inventory.status in ('返品処理','Amazon返品','廃棄') or inventory.amazon_returned_on is not null
      or inventory.returned_on is not null or (inventory.purchased_at is not null and inventory.purchased_at > p_sold_on) then
    return jsonb_build_object('status','review','reason','返品・廃棄、または仕入日より前の販売のため確認が必要です。');
  end if;
  select * into previous from app.amazon_sale_matches where item_id=inventory.id;
  if found then
    if previous.account_key<>p_account or previous.transaction_id<>p_transaction or previous.sku<>p_sku then
      return jsonb_build_object('status','review','reason','この在庫には別のAmazon取引が反映済みです。');
    end if;
    if inventory.sold_on is distinct from previous.sold_on or inventory.sold_price is distinct from previous.sold_price
      or inventory.payout_amount is distinct from previous.payout_amount then
      return jsonb_build_object('status','review','reason','反映後に手動変更されています。自動上書きしません。');
    end if;
    if previous.sold_on=p_sold_on and previous.sold_price=p_price and previous.payout_amount=p_payout then
      return jsonb_build_object('status','unchanged','reason','同じ内容を反映済みです。');
    end if;
  elsif (inventory.sold_on is not null and inventory.sold_on<>p_sold_on)
      or (inventory.sold_price is not null and inventory.sold_price<>p_price)
      or (inventory.payout_amount is not null and inventory.payout_amount<>p_payout) then
    return jsonb_build_object('status','review','reason','既存の販売記録と異なります。自動上書きしません。');
  end if;
  update app.items set sold_on=p_sold_on,sold_price=p_price,payout_amount=p_payout where id=inventory.id;
  insert into app.amazon_sale_matches(item_id,account_key,transaction_id,sku,sold_on,sold_price,payout_amount,applied_by)
    values(inventory.id,p_account,p_transaction,p_sku,p_sold_on,p_price,p_payout,p_actor)
    on conflict(item_id) do update set sold_on=excluded.sold_on,sold_price=excluded.sold_price,
      payout_amount=excluded.payout_amount,applied_by=excluded.applied_by,applied_at=now();
  return jsonb_build_object('status','applied','reason','販売日・販売価格・振込額を反映しました。');
end;
$$;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;
