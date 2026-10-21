-- Seller-side buyer feedback is independent from buyer receipt evaluation.
create table app.seller_feedback_receipts (
 channel text not null check(channel in ('メルカリ','ヤフオク')),
 external_id text not null,
 account_id text not null,
 item_id uuid not null references app.items(id),
 trade_key text not null,
 owner_id uuid not null,
 token uuid not null default gen_random_uuid(),
 state text not null check(state in ('reserved','submitting','succeeded','unknown','skipped')),
 note text not null default '',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(channel,external_id)
);
alter table app.seller_feedback_receipts enable row level security;
revoke all on app.seller_feedback_receipts from public,anon,authenticated;
grant select,insert,update on app.seller_feedback_receipts to authenticated;
create policy seller_feedback_admin on app.seller_feedback_receipts for all to authenticated
 using ((select app.is_admin())) with check ((select app.is_admin()));

create function app.seller_feedback_candidates(p_account_id text,p_ids text[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_account_id not in ('mercari-1','mercari-2','auctions-1','auctions-2') or p_account_id is null or coalesce(cardinality(p_ids),0)>40 then raise exception '対象を確認してください';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('external_id',l.external_id,'item_id',i.id,'sku',i.sku,'trade_key',l.trade_key,'state',r.state))
 from app.seller_listings l join app.items i on i.id=l.item_id
 left join app.seller_feedback_receipts r on r.channel=l.channel::text and r.external_id=l.external_id
 where l.account_id=p_account_id and l.external_id=any(p_ids) and l.active
 and l.channel=i.sales_channel and l.trade_key=i.seller_trade_key and l.trade_key<>l.external_id
 and l.observed_status in ('取引中','販売済') and i.status in ('取引中','販売済')
 and i.seller_cancelled_at is null and not coalesce(i.malfunction_reported,false)
 and not exists(select 1 from app.seller_operations o where o.item_id=i.id and o.status in ('queued','running','uncertain'))),'[]'::jsonb);
end $$;

create function app.seller_feedback_record(p_account_id text,p_external_id text,p_trade_key text,p_action text,p_token uuid default null,p_note text default '')
returns jsonb language plpgsql security invoker set search_path=pg_catalog,app as $$
declare candidate jsonb; receipt app.seller_feedback_receipts; ch text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ' when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク' end;
 if ch is null or p_external_id is null or not(case when ch='メルカリ' then p_external_id~'^m[0-9]+$' else p_external_id~'^[a-z][0-9]+$' end) or length(coalesce(p_note,''))>500 then raise exception '対象を確認してください';end if;
 perform pg_advisory_xact_lock(hashtextextended(ch||':'||p_external_id,1645));
 select * into receipt from app.seller_feedback_receipts where channel=ch and external_id=p_external_id for update;
 if p_action='reserve' then
  if receipt.external_id is not null then return jsonb_build_object('claimed',false,'state',receipt.state);end if;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が一致しません';end if;
  insert into app.seller_feedback_receipts(channel,external_id,account_id,item_id,trade_key,owner_id,state)
  values(ch,p_external_id,p_account_id,(candidate->>'item_id')::uuid,p_trade_key,auth.uid(),'reserved') returning * into receipt;
  return jsonb_build_object('claimed',true,'state',receipt.state,'token',receipt.token);
 end if;
 if receipt.external_id is null or receipt.owner_id<>auth.uid() or receipt.account_id<>p_account_id or receipt.trade_key is distinct from p_trade_key or receipt.token is distinct from p_token then raise exception '評価予約が一致しません';end if;
 if p_action='begin' then
  if receipt.state<>'reserved' then raise exception '評価は再送できません';end if;
  perform pg_advisory_xact_lock(hashtextextended(receipt.item_id::text,179050));
  perform 1 from app.items where id=receipt.item_id for update;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が変更されました';end if;
 elsif p_action='complete' then
  if receipt.state<>'submitting' then raise exception '送信状態が一致しません';end if;
 elsif p_action='unknown' then
  if receipt.state not in ('reserved','submitting') then raise exception '送信状態が一致しません';end if;
 elsif p_action='skip' then
  if receipt.state<>'reserved' then raise exception '送信状態が一致しません';end if;
 else raise exception '評価操作を確認してください';end if;
 update app.seller_feedback_receipts set state=case p_action when 'begin' then 'submitting' when 'complete' then 'succeeded' when 'skip' then 'skipped' else 'unknown' end,
 note=coalesce(p_note,''),updated_at=clock_timestamp() where channel=ch and external_id=p_external_id returning * into receipt;
 return jsonb_build_object('state',receipt.state);
end $$;
revoke all on function app.seller_feedback_candidates(text,text[]) from public,anon;
revoke all on function app.seller_feedback_record(text,text,text,text,uuid,text) from public,anon;
grant execute on function app.seller_feedback_candidates(text,text[]) to authenticated;
grant execute on function app.seller_feedback_record(text,text,text,text,uuid,text) to authenticated;
