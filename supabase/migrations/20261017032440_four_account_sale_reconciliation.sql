-- Read four sale accounts; keep listing publication defaults separate.
alter table app.seller_listings drop constraint seller_listings_account_id_check;
alter table app.seller_listings add constraint seller_listings_account_id_check
 check (account_id in ('mercari-1','mercari-2','auctions-1','auctions-2'));
alter table app.seller_listings add column verified_sale jsonb;
alter table app.seller_listings add column observed_status text;

-- Identity is independent of the currently selected sales channel.
-- Suffixes remain exact: 123, 123a and 123b are distinct inventory rows.
create function app.resolve_seller_observation_item(p_account_id text,p_row jsonb)
returns uuid language plpgsql stable set search_path=pg_catalog,app as $$
declare target uuid; n integer; serial text:=lower(p_row->>'serial');
begin
 select item_id into target from app.seller_listings
 where account_id=p_account_id and external_id=p_row->>'external_id';
 if found then return target;end if;
 if serial is null or serial!~'^[0-9]+[a-z]*$' or length(serial)>40 then return null;end if;
 select count(*),min(id::text)::uuid into n,target from app.items
 where app.product_serial(sku,lot_seq)=serial
 and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq));
 return case when n=1 then target else null end;
end $$;
revoke all on function app.resolve_seller_observation_item(text,jsonb) from public,anon,authenticated;

-- Only verified, unchanged sale values count toward Mercari's five in a row.
create function app.seller_observation_plan(p_account_id text,p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare row jsonb; i app.items; l app.seller_listings; ch app.sales_channel; action text; result jsonb:='[]';
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ'::app.sales_channel when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク'::app.sales_channel end;
 if ch is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>2000 or octet_length(p_rows::text)>1000000 then raise exception '取得情報を確認してください';end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  select * into i from app.items where id=app.resolve_seller_observation_item(p_account_id,row);
  select * into l from app.seller_listings where account_id=p_account_id and external_id=row->>'external_id';
  if i.id is null then action:='unmatched';
  elsif row->>'status'='販売済' then
   if i.status='販売済' and i.sales_channel=ch and i.sold_on is not null and i.sold_price is not null and i.payout_amount is not null
    and l.observed_status='販売済'
    and l.verified_sale=jsonb_build_object('sold_on',i.sold_on,'sold_price',i.sold_price,'payout_amount',i.payout_amount) then action:='registered';
   else action:='detail';end if;
  elsif i.sold_on is not null or i.status in ('販売済','返品処理','動作不良','Amazon補填申請中') then action:='protected';
  elsif l.active and l.observed_status=row->>'status' and i.sales_channel=ch
   and i.status::text=case when row->>'status'='支払い待ち' then '出品中' else row->>'status' end
   and i.seller_message_attention=coalesce((row->>'attention')::boolean,false) then action:='unchanged';
  elsif row->>'status' in ('取引中','キャンセル') then action:='detail';
  else action:='apply';end if;
  result:=result||jsonb_build_array(jsonb_build_object('external_id',row->>'external_id','action',action));
 end loop;
 return result;
end $$;
revoke all on function app.seller_observation_plan(text,jsonb) from public,anon;
grant execute on function app.seller_observation_plan(text,jsonb) to authenticated;

create or replace function app.sync_seller_observation(p_account_id text,p_observation jsonb)
returns text language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items; l app.seller_listings; ch app.sales_channel; ext text:=p_observation->>'external_id'; target uuid;
 observed timestamptz:=(p_observation->>'observed_at')::timestamptz; state text:=p_observation->>'status';
 trade text:=p_observation->>'trade_key'; day date; price numeric; payout numeric; proof jsonb;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ'::app.sales_channel when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク'::app.sales_channel end;
 if ch is null or observed is null or observed>clock_timestamp()+interval '5 minutes' or observed<clock_timestamp()-interval '1 day'
 or state not in ('出品中','支払い待ち','取引中','販売済','キャンセル') or state is null
 or not ((ch='メルカリ' and ext~'^m[0-9]+$') or (ch='ヤフオク' and ext~'^[a-z][0-9]+$')) or ext is null then raise exception '取得情報を確認してください';end if;
 if nullif(p_observation->>'trade_url','') is not null and (p_observation->>'trade_url')!~'^https://(jp[.]mercari[.]com/transaction/|contact[.]auctions[.]yahoo[.]co[.]jp/|buy[.]auctions[.]yahoo[.]co[.]jp/|aucpay[.]yahoo[.]co[.]jp/|salesmanagement[.]yahoo[.]co[.]jp/)' then raise exception '取引URLを確認してください';end if;
 target:=app.resolve_seller_observation_item(p_account_id,p_observation);
 if target is null then return 'unmatched';end if;
 perform pg_advisory_xact_lock(hashtextextended(target::text,179050));
 select * into i from app.items where id=target for update;
 select * into l from app.seller_listings where account_id=p_account_id and external_id=ext for update;
 if l.id is not null and l.item_id<>i.id then return 'unmatched';end if;
 if i.status in ('返品処理','動作不良','Amazon補填申請中') and i.sold_on is null then return 'protected';end if;
 if greatest(l.observed_at,i.marketplace_status_observed_at)>=observed then return 'stale';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) then return 'protected';end if;
 if state='販売済' then
  day:=(p_observation->>'sold_on')::date;
  if day is null or day>(clock_timestamp() at time zone 'Asia/Tokyo')::date or day<i.purchased_at
   or coalesce(p_observation->>'sold_price','')!~'^[0-9]{1,9}$' or coalesce(p_observation->>'payout_amount','')!~'^[0-9]{1,9}$'
   then raise exception '実際の販売日・販売金額・振込金額を確認できません';end if;
  price:=(p_observation->>'sold_price')::numeric;payout:=(p_observation->>'payout_amount')::numeric;
  if i.sold_on is not null and (i.sold_on<>day or (i.sold_price is not null and i.sold_price<>price)
   or (i.payout_amount is not null and i.payout_amount<>payout)) then return 'conflict';end if;
  if l.trade_key is not null and l.trade_key<>l.external_id and trade is distinct from l.trade_key then return 'unmatched';end if;
  proof:=jsonb_build_object('sold_on',day,'sold_price',price,'payout_amount',payout);
 else
  if i.sold_on is not null or i.status='販売済' then return 'protected';end if;
  if i.seller_cancelled_at is not null and (i.seller_cancelled_trade_key='*' or trade is null or trade=i.seller_cancelled_trade_key or trade=ext or state<>'取引中') then return 'protected';end if;
  if state='キャンセル' and (i.status<>'取引中' or trade is distinct from l.trade_key or l.id is null) then return 'protected';end if;
  if state<>'キャンセル' and i.status not in ('商品登録前','出品中','取引中') then return 'protected';end if;
  if state in ('取引中','支払い待ち') and trade is null then raise exception '取引IDを確認してください';end if;
  if i.status='取引中' and state in ('出品中','支払い待ち') then return 'protected';end if;
  -- Only confirmed purchases/sales can correct a forgotten channel.
  if i.sales_channel is distinct from ch and state<>'取引中' then return 'protected';end if;
 end if;
 -- One inventory item, one active listing; preserve older links as history.
 if state in ('取引中','販売済') then
  update app.seller_listings set active=false where item_id=i.id and active and id is distinct from l.id;
 elsif l.id is not null and not l.active then return 'protected';
 elsif exists(select 1 from app.seller_listings where item_id=i.id and active and id is distinct from l.id) then return 'unmatched';end if;
 if l.id is null then
  insert into app.seller_listings(item_id,channel,account_id,external_id,url)
  values(i.id,ch,p_account_id,ext,case when ch='メルカリ' then 'https://jp.mercari.com/item/'||ext else 'https://page.auctions.yahoo.co.jp/jp/auction/'||ext end) returning * into l;
 end if;
 if state='販売済' then
  update app.items set sales_channel=ch,sold_on=day,sold_price=price,payout_amount=payout,status='販売済',
   seller_trade_key=trade,marketplace_status_observed_at=observed where id=i.id;
 elsif state='キャンセル' then
  update app.items set status='出品中',seller_cancelled_trade_key=coalesce(trade,'*'),seller_cancelled_at=observed,marketplace_status_observed_at=observed where id=i.id;
 else
  update app.items set sales_channel=case when state='取引中' then ch else sales_channel end,
   status=case when state='支払い待ち' then '出品中'::app.item_status else state::app.item_status end,
   seller_trade_key=coalesce(trade,seller_trade_key),seller_cancelled_at=case when trade is not null and trade is distinct from seller_cancelled_trade_key then null else seller_cancelled_at end,
   marketplace_status_observed_at=observed,seller_message_attention=coalesce((p_observation->>'attention')::boolean,false) where id=i.id;
 end if;
 update app.seller_listings set active=true,observed_at=observed,observed_status=state,verified_sale=proof,
 trade_key=coalesce(trade,trade_key),trade_url=coalesce(p_observation->>'trade_url',trade_url) where id=l.id;
 return case when state='販売済' then 'registered' else 'updated' end;
end $$;
revoke all on function app.sync_seller_observation(text,jsonb) from public,anon;
grant execute on function app.sync_seller_observation(text,jsonb) to authenticated;

-- Existing shipping/message actions follow the linked account, not the publication default.
do $$declare d text;begin
 d:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 d:=replace(d,'case when i.sales_channel=''メルカリ'' then ''mercari-2'' else ''auctions-1'' end',
 'case when p_kind<>''listing'' and link.id is not null then link.account_id when i.sales_channel=''メルカリ'' then ''mercari-2'' else ''auctions-1'' end');
 execute d;
end $$;
notify pgrst,'reload schema';
