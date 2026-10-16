-- 管理者セッション専用。既存の登録関数を使い、権限の迂回はしない。
alter table app.marketplace_tracking_tasks drop constraint marketplace_tracking_tasks_confirmation_status_check;
alter table app.marketplace_tracking_tasks add constraint marketplace_tracking_tasks_confirmation_status_check
check(confirmation_status in ('追跡番号不一致','在庫未一致','在庫ID重複','追跡番号未取得','ログイン切れ','追加承認待ち','アカウント未確認','画面確認待ち','評価結果要確認','評価処理保留'));
create or replace function app.marketplace_extension_probe(p_marketplace app.marketplace, p_item_id text)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare v_items jsonb;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or nullif(trim(p_item_id),'') is null or length(p_item_id)>100 then raise exception '照合条件が不正です'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'sku',sku,'marketplace',marketplace,'tracking_no',tracking_no,'inspected_at',inspected_at,'cleaned_at',cleaned_at)), '[]'::jsonb)
    into v_items from app.items
    where marketplace_item_id=p_item_id and (marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and marketplace in ('ヤフフリ','PayPayフリマ')));
  return jsonb_build_object('items',v_items,'count',jsonb_array_length(v_items));
end $$;
revoke all on function app.marketplace_extension_probe(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_extension_probe(app.marketplace,text) to authenticated;

create table if not exists app.marketplace_extension_receipts (
  marketplace text not null, marketplace_item_id text not null,
  token uuid not null unique default gen_random_uuid(), account_label text not null,
  state text not null check(state in ('reserved','submitting','succeeded','unknown')),
  reserved_by uuid not null, reserved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), details text,
  primary key(marketplace,marketplace_item_id)
);
alter table app.marketplace_extension_receipts enable row level security;
revoke all on app.marketplace_extension_receipts from public,anon;
grant select,insert,update,delete on app.marketplace_extension_receipts to authenticated;
drop policy if exists marketplace_extension_receipts_admin on app.marketplace_extension_receipts;
create policy marketplace_extension_receipts_admin on app.marketplace_extension_receipts
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

create or replace function app.marketplace_extension_receipt(p_action text,p_marketplace app.marketplace,p_item_id text,p_account_label text,p_token uuid default null,p_details text default null)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare v_market text; v_probe jsonb; v_row app.marketplace_extension_receipts%rowtype; v_token uuid;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です'; end if;
  if p_action not in ('reserve','begin','complete','unknown','release') then raise exception '操作が不正です'; end if;
  if nullif(trim(p_account_label),'') is null or length(p_account_label)>200 then raise exception 'アカウント識別が必要です'; end if;
  v_probe=app.marketplace_extension_probe(p_marketplace,p_item_id);
  v_market=case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end;
  perform pg_advisory_xact_lock(hashtextextended(v_market||':'||p_item_id,0));
  select * into v_row from app.marketplace_extension_receipts where marketplace=v_market and marketplace_item_id=p_item_id for update;
  if p_action='reserve' then
    if (v_probe->>'count')::int<>1 then return jsonb_build_object('eligible',false,'reason','在庫1件一致が必要です'); end if;
    if v_probe->'items'->0->>'inspected_at' is null or v_probe->'items'->0->>'cleaned_at' is null then return jsonb_build_object('eligible',false,'reason','検品・清掃の記録待ち'); end if;
    if v_row.state is not null then return jsonb_build_object('eligible',false,'reason','既存の評価記録: '||v_row.state); end if;
    insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
      values(v_market,p_item_id,p_account_label,'reserved',auth.uid()) returning token into v_token;
    return jsonb_build_object('eligible',true,'token',v_token,'sku',v_probe->'items'->0->>'sku');
  end if;
  if v_row.token is distinct from p_token or v_row.reserved_by is distinct from auth.uid() or v_row.account_label<>p_account_label then raise exception '評価予約が一致しません'; end if;
  if p_action='begin' then
    if v_row.state<>'reserved' or v_row.reserved_at<now()-interval '5 minutes' then raise exception '評価予約が期限切れか送信済みです'; end if;
    if (v_probe->>'count')::int<>1 or v_probe->'items'->0->>'inspected_at' is null or v_probe->'items'->0->>'cleaned_at' is null then raise exception '評価条件が変わりました'; end if;
    update app.marketplace_extension_receipts set state='submitting',updated_at=now() where token=p_token;
  elsif p_action='release' then
    if v_row.state<>'reserved' then raise exception '送信開始後は予約を解除できません'; end if;
    delete from app.marketplace_extension_receipts where token=p_token;
  elsif p_action in ('complete','unknown') then
    if v_row.state not in ('submitting','unknown') then raise exception '送信状態が不正です'; end if;
    update app.marketplace_extension_receipts set state=case when p_action='complete' then 'succeeded' else 'unknown' end,details=left(p_details,2000),updated_at=now() where token=p_token;
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function app.marketplace_extension_receipt(text,app.marketplace,text,text,uuid,text) from public,anon;
grant execute on function app.marketplace_extension_receipt(text,app.marketplace,text,text,uuid,text) to authenticated;
