-- Retain the legacy table/RPC name for existing clients and history; support both marketplaces.
create or replace function app.mercari_shipping_handoff(
  p_item_id uuid, p_trade_key text, p_confirm boolean default false
) returns text
language plpgsql security definer set search_path = pg_catalog, app
as $function$
declare
  actor uuid := app.current_staff_id();
  item app.items;
  listing app.seller_listings;
  code_id uuid;
begin
  if auth.uid() is null or not exists(select 1 from app.staff where id=actor and is_active) then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;

  if p_confirm then
    select * into item from app.items where id=p_item_id for update;
  else
    select * into item from app.items where id=p_item_id;
  end if;
  if item.id is null or (item.deliverer_id is distinct from actor and not app.is_admin()) then
    raise exception '納品担当者または管理者のみ操作できます' using errcode='42501';
  end if;

  select * into listing from app.seller_listings
  where item_id=item.id and active and channel=item.sales_channel and channel in ('メルカリ','ヤフオク') and trade_key=p_trade_key;
  if listing.id is null or item.sales_channel not in ('メルカリ','ヤフオク') or item.seller_trade_key is distinct from p_trade_key
    or item.seller_cancelled_at is not null then
    raise exception '現在の販売取引を確認してください';
  end if;

  if item.status='販売済' or exists(
    select 1 from app.seller_operations o
    where o.item_id=item.id and o.account_id=listing.account_id and o.channel=listing.channel
     and o.payload->>'trade_key'=p_trade_key and o.kind='ship_notice'
     and o.status='succeeded' and o.result->>'notified'='true'
  ) then return 'notified';end if;
  if item.status<>'取引中' or item.sold_on is not null then
    raise exception '取引中の商品を確認してください';
  end if;

  select o.id into code_id from app.seller_operations o
  where o.item_id=item.id and o.account_id=listing.account_id and o.channel=listing.channel
   and o.payload->>'trade_key'=p_trade_key and o.kind in ('shipping_code','register_package')
   and o.status='succeeded'
  order by o.created_at desc,o.id desc limit 1;

  if exists (
    select 1 from app.mercari_shipping_handoffs h
    where h.listing_id=listing.id and h.trade_key=p_trade_key
     and h.deliverer_id is not distinct from item.deliverer_id
     and h.code_operation_id is not distinct from code_id
  ) then return 'confirmed';end if;
  if not p_confirm then return 'pending';end if;

  if exists(
    select 1 from app.seller_operations o where o.item_id=item.id and o.status in ('queued','running','uncertain')
  ) then raise exception '取引の操作結果が確定してから記録してください';end if;
  insert into app.mercari_shipping_handoffs (
    listing_id,trade_key,code_operation_id,deliverer_id,confirmed_by
  ) values (listing.id,p_trade_key,code_id,item.deliverer_id,actor)
  on conflict (listing_id,trade_key) do update
  set code_operation_id=excluded.code_operation_id,deliverer_id=excluded.deliverer_id,
      confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at;
  return 'confirmed';
end
$function$;

revoke all on function app.mercari_shipping_handoff(uuid,text,boolean) from public, anon;
grant execute on function app.mercari_shipping_handoff(uuid,text,boolean) to authenticated;

CREATE OR REPLACE FUNCTION app.extension_daily_shipping_candidates(p_account_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if cardinality(p_account_ids) not between 1 and 4 or exists(select 1 from unnest(p_account_ids) a where a not in ('mercari-1','mercari-2','auctions-1','auctions-2') or a is null) then raise exception '対象アカウントを確認してください';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (
 select i.id item_id,i.sku inventory_sku,i.updated_at expected_updated_at,l.channel,l.account_id,l.external_id,l.trade_key,
 coalesce(l.trade_url,l.url) url,p.result->'shipping_receipt' receipt,p.payload,
 h.listing_id is not null as handoff_confirmed
 from app.items i join app.seller_listings l on l.item_id=i.id and l.active and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key
 left join lateral(select o.id,o.payload,o.result,o.finished_at from app.seller_operations o where o.item_id=i.id and o.account_id=l.account_id and o.channel=l.channel
  and o.kind in ('shipping_code','register_package') and o.status='succeeded' and o.payload->>'trade_key'=l.trade_key order by o.created_at desc,o.id desc limit 1) p on true
 join app.mercari_shipping_handoffs h on l.channel in ('メルカリ','ヤフオク') and h.listing_id=l.id and h.trade_key=l.trade_key
   and h.deliverer_id is not distinct from i.deliverer_id and h.code_operation_id is not distinct from p.id
 where l.account_id=any(p_account_ids) and i.status='取引中' and i.sold_on is null and i.seller_cancelled_at is null
 -- A matching staff handoff is required; no code age or dated trade key is required.
 and not exists(select 1 from app.seller_operations o where o.item_id=i.id and (o.status in ('queued','running','uncertain')
  or o.kind='ship_notice' and o.payload->>'trade_key'=l.trade_key and (o.status='succeeded' and o.result->>'notified'='true'
  or o.payload->>'automatic_day'=((now() at time zone 'Asia/Tokyo')::date)::text)))
 order by (h.listing_id is not null) desc,i.id limit 50) q),'[]'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION app.extension_claim_daily_shipping_notice(p_item_id uuid, p_trade_key text, p_expected_updated_at timestamp with time zone, p_proof jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app'
AS $function$
declare i app.items;l app.seller_listings;o app.seller_operations;source text;accepted timestamptz;code_finished timestamptz;code_id uuid;handoff_confirmed boolean;observed timestamptz;trade_day date;day text:=(clock_timestamp() at time zone 'Asia/Tokyo')::date::text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>2000 then raise exception '発送根拠を確認してください';end if;
 select * into i from app.items where id=p_item_id for update;
 select * into l from app.seller_listings where item_id=i.id and active;
 if i.id is null or i.status<>'取引中' or i.sold_on is not null or i.seller_cancelled_at is not null or i.updated_at is distinct from p_expected_updated_at
 or l.id is null or l.channel<>i.sales_channel or l.trade_key is distinct from p_trade_key or i.seller_trade_key is distinct from p_trade_key then return null;end if;
 -- Recheck the latest code after locking the item, in case it was reissued after the daily scan.
 select p.id,p.finished_at into code_id,code_finished
 from app.seller_operations p
 where p.item_id=i.id and p.kind in ('shipping_code','register_package') and p.status='succeeded'
   and p.account_id=l.account_id and p.channel=l.channel and p.payload->>'trade_key'=p_trade_key
 order by p.created_at desc,p.id desc limit 1;
 handoff_confirmed:=l.channel in ('メルカリ','ヤフオク') and exists(
  select 1 from app.mercari_shipping_handoffs h
  where h.listing_id=l.id and h.trade_key=l.trade_key and h.deliverer_id is not distinct from i.deliverer_id
   and h.code_operation_id is not distinct from code_id
 );
 if not handoff_confirmed then return null;end if;
 if exists(select 1 from app.seller_operations p where p.item_id=i.id and (p.status in ('queued','running','uncertain')
  or p.kind='ship_notice' and p.payload->>'trade_key'=p_trade_key and (p.status='succeeded' and p.result->>'notified'='true' or p.payload->>'automatic_day'=day))) then return null;end if;
 begin observed:=(p_proof->>'observed_at')::timestamptz;exception when others then return null;end;
 if observed is null or observed<clock_timestamp()-interval '5 minutes' or observed>clock_timestamp()+interval '30 seconds' then return null;end if;
 if p_proof->>'already_notified' is distinct from 'true' and
  (p_proof->>'source' is distinct from 'delivery_handoff' or p_proof->>'accepted' is distinct from 'true') then return null;end if;
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,claimed_at)
 values(gen_random_uuid(),i.id,app.current_staff_id(),'ship_notice',l.channel,l.account_id,i.status,i.updated_at,
 jsonb_build_object('trade_key',p_trade_key,'automatic_day',day,'automatic_receipt',p_proof),'running',clock_timestamp()) returning * into o;
 return to_jsonb(o)||jsonb_build_object('external_id',l.external_id,'trade_key',l.trade_key,'url',coalesce(l.trade_url,l.url));
end $function$;

notify pgrst,'reload schema';
