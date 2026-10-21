create or replace function app.seller_feedback_record(p_account_id text,p_external_id text,p_trade_key text,p_action text,p_token uuid default null,p_note text default '')
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
 if receipt.external_id is null or receipt.owner_id<>auth.uid() or receipt.account_id<>p_account_id or receipt.trade_key is distinct from p_trade_key then raise exception '評価予約が一致しません';end if;
 -- Manual result review only: this does not reset the reservation or authorize a site submission.
 if p_action='review' and receipt.state='unknown' then return jsonb_build_object('state',receipt.state,'token',receipt.token);end if;
 if receipt.token is distinct from p_token then raise exception '評価予約が一致しません';end if;
 if p_action='begin' then
  if receipt.state<>'reserved' then raise exception '評価は再送できません';end if;
  perform pg_advisory_xact_lock(hashtextextended(receipt.item_id::text,179050));
  perform 1 from app.items where id=receipt.item_id for update;
  candidate:=app.seller_feedback_candidates(p_account_id,array[p_external_id])->0;
  if candidate is null or candidate->>'trade_key' is distinct from p_trade_key then raise exception '販売在庫・取引が変更されました';end if;
 elsif p_action='complete' then
  if receipt.state<>'submitting' and not(receipt.state='unknown' and p_note='実画面で完了を再確認') then raise exception '送信状態が一致しません';end if;
 elsif p_action='unknown' then
  if receipt.state not in ('reserved','submitting') then raise exception '送信状態が一致しません';end if;
 elsif p_action='skip' then
  if receipt.state<>'reserved' then raise exception '送信状態が一致しません';end if;
 else raise exception '評価操作を確認してください';end if;
 update app.seller_feedback_receipts set state=case p_action when 'begin' then 'submitting' when 'complete' then 'succeeded' when 'skip' then 'skipped' else 'unknown' end,
 note=coalesce(p_note,''),updated_at=clock_timestamp() where channel=ch and external_id=p_external_id returning * into receipt;
 return jsonb_build_object('state',receipt.state);
end $$;
