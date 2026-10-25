create or replace function app.marketplace_price_record(p_account_id text,p_external_id text,p_action text,p_day date,p_before bigint default null,p_after bigint default null,p_title text default null,p_token uuid default null,p_note text default '') returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare r app.marketplace_price_changes;i app.items;l app.seller_listings;matches text[];stamp timestamp:=clock_timestamp() at time zone 'Asia/Tokyo';
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '管理者認証が必要です' using errcode='42501';end if;
 if p_account_id not in ('mercari-1','mercari-2') or p_account_id is null or p_external_id !~ '^m[0-9]+$' or p_external_id is null or p_day is null then raise exception '対象を確認してください';end if;
 perform pg_advisory_xact_lock(hashtextextended('marketplace-price:'||p_external_id,0));
 select * into r from app.marketplace_price_changes where channel='メルカリ' and external_id=p_external_id and day=p_day for update;
 if p_action='reserve' then
  if p_day<>stamp::date or extract(hour from stamp)<12 then raise exception '正午12時以降の当日処理だけ実行できます';end if;
  if r.external_id is not null or exists(select 1 from app.marketplace_price_changes where channel='メルカリ' and external_id=p_external_id and state in ('reserved','submitting','unknown')) then return jsonb_build_object('claimed',false);end if;
  select * into l from app.seller_listings where channel='メルカリ' and account_id=p_account_id and external_id=p_external_id and active;
  if l.item_id is null then raise exception '出品と在庫が一致しません';end if;
  select * into i from app.items where id=l.item_id for update;
  if i.status<>'出品中' or l.observed_status<>'出品中' or i.sold_on is not null or i.sales_channel<>l.channel or i.seller_cancelled_at is not null or coalesce(i.malfunction_reported,false) or exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain')) then raise exception '商品状態が変更されています';end if;
  select array_agg(lower(m[1])) into matches from regexp_matches(coalesce(p_title,''),'[【\[]([0-9]+[a-zA-Z]*)[】\]]','g') m;
  if coalesce(cardinality(matches),0)<>1 or matches[1]<>lower(split_part(i.sku,'-',1)) or length(p_title)>256 or p_before not between 400 and 9999999 or p_before is null or p_after is distinct from p_before-100 then raise exception '通番号・価格が一致しません';end if;
  insert into app.marketplace_price_changes(channel,external_id,day,account_id,item_id,before_price,after_price,title,state) values('メルカリ',p_external_id,p_day,p_account_id,i.id,p_before,p_after,p_title,'reserved') returning * into r;
  return jsonb_build_object('claimed',true,'token',r.token);
 end if;
 if r.external_id is null or r.account_id<>p_account_id or r.token is distinct from p_token then raise exception '予約が一致しません';end if;
 if p_action='begin' then
  if r.state<>'reserved' or p_day<>stamp::date or extract(hour from stamp)<12 or clock_timestamp()-r.created_at>interval '10 minutes' then raise exception '予約期限・状態を確認してください';end if;
  select * into i from app.items where id=r.item_id for update;
  if i.status<>'出品中' or i.sold_on is not null or i.seller_cancelled_at is not null or coalesce(i.malfunction_reported,false) or exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain')) or not exists(select 1 from app.seller_listings listing where listing.item_id=i.id and listing.external_id=p_external_id and listing.account_id=p_account_id and listing.channel=i.sales_channel and listing.active and listing.observed_status='出品中') then raise exception '送信前の商品状態が変わりました';end if;
  update app.marketplace_price_changes set state='submitting',updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='complete' and r.state='submitting' then
  update app.marketplace_price_changes set state='succeeded',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='unknown' and r.state='submitting' then
  update app.marketplace_price_changes set state='unknown',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 elsif p_action='failed' and r.state='reserved' then
  update app.marketplace_price_changes set state='failed',note=left(coalesce(p_note,''),500),updated_at=clock_timestamp() where channel=r.channel and external_id=r.external_id and day=r.day;
 else raise exception '送信状態を自動解除・再実行できません';end if;
 return jsonb_build_object('recorded',true);
end $$;
