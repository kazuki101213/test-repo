-- One lightweight candidate query per profile/day. No notice merely from a generated code.
create unique index seller_automatic_notice_day on app.seller_operations(item_id,(payload->>'trade_key'),(payload->>'automatic_day'))
where kind='ship_notice' and payload ? 'automatic_day';

create function app.extension_daily_shipping_candidates(p_account_ids text[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if cardinality(p_account_ids) not between 1 and 4 or exists(select 1 from unnest(p_account_ids) a where a not in ('mercari-1','mercari-2','auctions-1','auctions-2') or a is null) then raise exception '対象アカウントを確認してください';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (
 select i.id item_id,i.sku inventory_sku,i.updated_at expected_updated_at,l.channel,l.account_id,l.external_id,l.trade_key,
 coalesce(l.trade_url,l.url) url,p.result->'shipping_receipt' receipt,p.payload
 from app.items i join app.seller_listings l on l.item_id=i.id and l.active and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key
 join lateral(select o.payload,o.result from app.seller_operations o where o.item_id=i.id and o.account_id=l.account_id and o.channel=l.channel
  and o.kind in ('shipping_code','register_package') and o.status='succeeded' and o.payload->>'trade_key'=l.trade_key order by o.created_at desc limit 1) p on true
 where l.account_id=any(p_account_ids) and i.status='取引中' and i.sold_on is null and i.seller_cancelled_at is null
 and l.trade_key ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}'
 and not exists(select 1 from app.seller_operations o where o.item_id=i.id and (o.status in ('queued','running','uncertain')
  or o.kind='ship_notice' and o.payload->>'trade_key'=l.trade_key and (o.status='succeeded' and o.result->>'notified'='true'
  or o.payload->>'automatic_day'=((now() at time zone 'Asia/Tokyo')::date)::text)))
 order by i.id limit 50) q),'[]'::jsonb);
end $$;

create function app.extension_claim_daily_shipping_notice(p_item_id uuid,p_trade_key text,p_expected_updated_at timestamptz,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;l app.seller_listings;o app.seller_operations;source text;accepted timestamptz;observed timestamptz;trade_day date;day text:=(clock_timestamp() at time zone 'Asia/Tokyo')::date::text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>2000 then raise exception '発送根拠を確認してください';end if;
 select * into i from app.items where id=p_item_id for update;
 select * into l from app.seller_listings where item_id=i.id and active;
 if i.id is null or i.status<>'取引中' or i.sold_on is not null or i.seller_cancelled_at is not null or i.updated_at is distinct from p_expected_updated_at
 or l.id is null or l.channel<>i.sales_channel or l.trade_key is distinct from p_trade_key or i.seller_trade_key is distinct from p_trade_key then return null;end if;
 if not exists(select 1 from app.seller_operations p where p.item_id=i.id and p.kind in ('shipping_code','register_package') and p.status='succeeded'
  and p.account_id=l.account_id and p.channel=l.channel and p.payload->>'trade_key'=p_trade_key) then return null;end if;
 if exists(select 1 from app.seller_operations p where p.item_id=i.id and (p.status in ('queued','running','uncertain')
  or p.kind='ship_notice' and p.payload->>'trade_key'=p_trade_key and (p.status='succeeded' and p.result->>'notified'='true' or p.payload->>'automatic_day'=day))) then return null;end if;
 begin observed:=(p_proof->>'observed_at')::timestamptz;exception when others then return null;end;
 if observed is null or observed<clock_timestamp()-interval '5 minutes' or observed>clock_timestamp()+interval '30 seconds' then return null;end if;
 if p_proof->>'already_notified' is distinct from 'true' then
  source:=p_proof->>'source';
  if p_proof->>'accepted' is distinct from 'true' or coalesce(p_proof->>'tracking_number','')!~'^[0-9]{11,13}$'
   or not ((p_proof->>'carrier'='yamato' and source='https://toi.kuronekoyamato.co.jp/cgi-bin/tneko')
   or (p_proof->>'carrier'='japanpost' and source='https://trackings.post.japanpost.jp/services/srv/search')) then return null;end if;
  begin accepted:=(p_proof->>'accepted_at')::timestamptz;trade_day:=substring(p_trade_key from ':([0-9]{4}-[0-9]{2}-[0-9]{2})')::date;exception when others then return null;end;
  if accepted is null or trade_day is null or (accepted at time zone 'Asia/Tokyo')::date<trade_day or accepted>clock_timestamp() or accepted<clock_timestamp()-interval '90 days' then return null;end if;
 end if;
 insert into app.seller_operations(item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload,status,claimed_at)
 values(i.id,app.current_staff_id(),'ship_notice',l.channel,l.account_id,i.status,i.updated_at,
 jsonb_build_object('trade_key',p_trade_key,'automatic_day',day,'automatic_receipt',p_proof),'running',clock_timestamp()) returning * into o;
 return to_jsonb(o)||jsonb_build_object('external_id',l.external_id,'trade_key',l.trade_key,'url',coalesce(l.trade_url,l.url));
end $$;
revoke all on function app.extension_daily_shipping_candidates(text[]),app.extension_claim_daily_shipping_notice(uuid,text,timestamptz,jsonb) from public,anon;
grant execute on function app.extension_daily_shipping_candidates(text[]),app.extension_claim_daily_shipping_notice(uuid,text,timestamptz,jsonb) to authenticated;
