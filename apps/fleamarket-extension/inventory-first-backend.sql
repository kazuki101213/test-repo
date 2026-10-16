
alter table app.marketplace_tracking_tasks drop constraint marketplace_tracking_tasks_confirmation_status_check;
alter table app.marketplace_tracking_tasks add constraint marketplace_tracking_tasks_confirmation_status_check check(confirmation_status in ('追跡番号不一致','在庫未一致','在庫ID重複','追跡番号未取得','ログイン切れ','追加承認待ち','アカウント未確認','画面確認待ち','評価結果要確認','評価処理保留','商品ID記載なし','同一商品IDがなし','追跡番号記載なし','名前不一致'));
drop index app.marketplace_tracking_tasks_open_unique;
create unique index marketplace_tracking_tasks_open_unique on app.marketplace_tracking_tasks(marketplace,account_label,(coalesce(marketplace_item_id,sku,'')),confirmation_status) where state='未確認';

create or replace function app.marketplace_tracking_candidates(p_marketplace app.marketplace)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare result jsonb; today date:=(now() at time zone 'Asia/Tokyo')::date; cutoff date:=(today-interval '1 month')::date;
begin
 if not(current_user in ('postgres','service_role') or (auth.uid() is not null and app.is_admin())) then raise exception '管理者認証が必要です'; end if;
 if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象サイトが不正です'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sku',i.sku,'model_no',p.model_no,'itemId',i.marketplace_item_id,'purchasedAt',i.purchased_at) order by i.purchased_at desc,i.sku),'[]'::jsonb) into result
 from app.items i left join app.products p on p.id=i.product_id
 where (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
 and i.purchased_at between cutoff and today and nullif(trim(i.tracking_no),'') is null;
 return jsonb_build_object('day',today,'cutoff',cutoff,'items',result);
end $$;
revoke all on function app.marketplace_tracking_candidates(app.marketplace) from public,anon;
grant execute on function app.marketplace_tracking_candidates(app.marketplace) to authenticated;

create table app.marketplace_inventory_scans(
 day date not null,marketplace text not null,account_label text not null,
 candidate_ids jsonb not null,found_ids jsonb not null,stop_reason text not null,
 updated_at timestamptz not null default now(),primary key(day,marketplace,account_label)
);
alter table app.marketplace_inventory_scans enable row level security;
revoke all on app.marketplace_inventory_scans from public,anon;
grant select,insert,update on app.marketplace_inventory_scans to authenticated;
create policy marketplace_inventory_scans_admin on app.marketplace_inventory_scans to authenticated using(app.is_admin()) with check(app.is_admin());

create or replace function app.marketplace_inventory_scan_complete(p_marketplace app.marketplace,p_account_label text,p_meta jsonb)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare market text; required_labels text[]; ident text; inventory app.items%rowtype; today date:=(now() at time zone 'Asia/Tokyo')::date; created integer:=0;
begin
 if not(current_user in ('postgres','service_role') or (auth.uid() is not null and app.is_admin())) then raise exception '管理者認証が必要です'; end if;
 market:=case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end;
 required_labels:=case market when 'メルカリ' then array['メルカリ1','メルカリ2'] when 'ヤフオク' then array['ヤフオク1','ヤフオク2'] when 'Yahoo!フリマ' then array['Yahoo!フリマ1','Yahoo!フリマ2'] when 'ラクマ' then array['ラクマ1'] end;
 if required_labels is null or not(p_account_label=any(required_labels)) or p_meta->>'stop_reason' not in ('month-cutoff','end-of-list','all-found','no-candidates') or (p_meta->>'day')::date<>today or jsonb_typeof(p_meta->'candidate_ids')<>'array' or jsonb_typeof(p_meta->'found_ids')<>'array' then raise exception '検索終了記録が不正です'; end if;
 perform pg_advisory_xact_lock(hashtextextended(today::text||':'||market,0));
 insert into app.marketplace_inventory_scans(day,marketplace,account_label,candidate_ids,found_ids,stop_reason)
 values(today,market,p_account_label,p_meta->'candidate_ids',p_meta->'found_ids',p_meta->>'stop_reason')
 on conflict(day,marketplace,account_label) do update set candidate_ids=excluded.candidate_ids,found_ids=excluded.found_ids,stop_reason=excluded.stop_reason,updated_at=now();
 for ident in select jsonb_array_elements_text(p_meta->'candidate_ids') loop
  if (select count(*) from app.marketplace_inventory_scans where day=today and marketplace=market and account_label=any(required_labels) and candidate_ids ? ident)<>cardinality(required_labels) then continue; end if;
  if exists(select 1 from app.marketplace_inventory_scans where day=today and marketplace=market and found_ids ? ident) then continue; end if;
  select * into inventory from app.items where id=ident::uuid;
  if found and nullif(trim(inventory.marketplace_item_id),'') is not null then
   perform app.reconcile_marketplace_tracking(p_marketplace,'サイト全アカウント確認',inventory.marketplace_item_id,null,'同一商品IDがなし',jsonb_build_object('inventory_id',inventory.id,'reason','同一商品IDがなし','note',array_to_string(required_labels,'・')||'を1ヶ月範囲の末尾まで検索済み')::text);created:=created+1;
  end if;
 end loop;
 return jsonb_build_object('result','search_recorded','tasks',created);
end $$;
revoke all on function app.marketplace_inventory_scan_complete(app.marketplace,text,jsonb) from public,anon;
grant execute on function app.marketplace_inventory_scan_complete(app.marketplace,text,jsonb) to authenticated;
CREATE OR REPLACE FUNCTION app.reconcile_marketplace_tracking(p_marketplace app.marketplace, p_account_label text, p_marketplace_item_id text, p_site_tracking_no text, p_confirmation_status text DEFAULT NULL::text, p_details text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare
  v_count integer;
  v_item app.items%rowtype;
  v_status text;
  v_meta jsonb;
  v_inventory app.items%rowtype;
  v_model text;
  v_sku text;
  v_item_id text := nullif(trim(p_marketplace_item_id), '');
  v_site_no text := nullif(trim(p_site_tracking_no), '');
begin
  if not (
    current_user in ('postgres', 'service_role')
    or (auth.uid() is not null and app.current_role() = 'admin')
  ) then
    raise exception '管理者または信頼済み運用接続が必要です';
  end if;


  if left(coalesce(p_details,''),1)='{' then v_meta:=p_details::jsonb; end if;
  if p_confirmation_status='inventory_search_complete' then
    return app.marketplace_inventory_scan_complete(p_marketplace,p_account_label,v_meta);
  end if;
  if v_meta ? 'inventory_id' then
    select * into v_inventory from app.items where id=(v_meta->>'inventory_id')::uuid;
    if not found or v_inventory.marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
      or not (v_inventory.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_inventory.marketplace in ('ヤフフリ','PayPayフリマ')))
      or v_inventory.purchased_at not between ((now() at time zone 'Asia/Tokyo')::date-interval '1 month')::date and (now() at time zone 'Asia/Tokyo')::date
      or nullif(trim(v_inventory.tracking_no),'') is not null then return jsonb_build_object('result','skipped','reason','対象在庫の条件が変更されています'); end if;
    if v_inventory.marketplace_item_id is distinct from v_item_id and not(nullif(trim(v_inventory.marketplace_item_id),'') is null and v_item_id is null) then raise exception '在庫の商品IDが一致しません'; end if;
    v_sku:=v_inventory.sku;
    select model_no into v_model from app.products where id=v_inventory.product_id;
    p_details:=format('理由=%s; 型番=%s; SKU=%s; 商品ID=%s; %s',coalesce(v_meta->>'reason',p_confirmation_status,'追跡番号登録'),coalesce(v_model,'型番未登録'),coalesce(v_sku,'SKU未登録'),coalesce(v_item_id,'記載なし'),coalesce(v_meta->>'note',''));
  end if;
  if p_confirmation_status in ('商品ID記載なし','同一商品IDがなし','追跡番号記載なし','名前不一致') then
    if p_confirmation_status='商品ID記載なし' and (v_meta is null or not(v_meta ? 'inventory_id') or v_item_id is not null) then raise exception '商品ID未記載タスクの在庫指定が不正です'; end if;
    insert into app.marketplace_tracking_tasks(marketplace,account_label,marketplace_item_id,sku,confirmation_status,details)
      values(p_marketplace,coalesce(p_account_label,''),v_item_id,v_sku,p_confirmation_status,p_details)
      on conflict(marketplace,account_label,(coalesce(marketplace_item_id,sku,'')),confirmation_status) where state='未確認'
      do update set details=excluded.details,sku=excluded.sku,updated_at=now();
    return jsonb_build_object('result','task_created','status',p_confirmation_status,'sku',v_sku);
  end if;
  if p_confirmation_status in ('ログイン切れ', '追加承認待ち', 'アカウント未確認', '画面確認待ち', '評価結果要確認', '評価処理保留') then
    insert into app.marketplace_tracking_tasks
      (marketplace, account_label, marketplace_item_id, site_tracking_no, confirmation_status, details)
    values (p_marketplace, coalesce(p_account_label, ''), v_item_id, v_site_no, p_confirmation_status, p_details)
    on conflict (marketplace, account_label, (coalesce(marketplace_item_id, sku, '')), confirmation_status)
      where state = '未確認'
    do update set site_tracking_no = excluded.site_tracking_no,
      details = excluded.details, updated_at = now();
    return jsonb_build_object('result', 'task_created', 'status', p_confirmation_status);
  end if;

  if v_item_id is null then raise exception '商品IDが空です'; end if;

  -- 判定中の在庫追加・変更を直列化し、1件一致と空欄条件を同時に保つ。
  lock table app.items in share row exclusive mode;

  select count(*)::integer into v_count from app.items
  where (marketplace = p_marketplace or (p_marketplace in ('ヤフフリ', 'PayPayフリマ') and marketplace in ('ヤフフリ', 'PayPayフリマ'))) and marketplace_item_id = v_item_id;

  if v_count = 0 then v_status := '在庫未一致';
  elsif v_count > 1 then
    v_status := '在庫ID重複';
    select coalesce(p_details, '') || '; 重複候補: ' || string_agg(format('SKU=%s, アプリ追跡番号=%s', sku, coalesce(tracking_no, '未入力')), '; ' order by sku)
    into p_details from app.items
    where (marketplace = p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and marketplace in ('ヤフフリ','PayPayフリマ'))) and marketplace_item_id = v_item_id;
  else
    select * into v_item from app.items
    where (marketplace = p_marketplace or (p_marketplace in ('ヤフフリ', 'PayPayフリマ') and marketplace in ('ヤフフリ', 'PayPayフリマ'))) and marketplace_item_id = v_item_id;
    if v_site_no is null then
      v_status := '追跡番号未取得';
    elsif nullif(trim(v_item.tracking_no), '') is null then
      update app.items set tracking_no = v_site_no
      where id = v_item.id and nullif(trim(tracking_no), '') is null;
      if found then
        update app.marketplace_tracking_tasks set state = '確認済み', updated_at = now()
        where (marketplace = p_marketplace or (p_marketplace in ('ヤフフリ', 'PayPayフリマ') and marketplace in ('ヤフフリ', 'PayPayフリマ'))) and marketplace_item_id = v_item_id and account_label = coalesce(p_account_label, '') and state = '未確認' and confirmation_status in ('追跡番号不一致','在庫未一致','在庫ID重複','追跡番号未取得');
        return jsonb_build_object('result', 'updated', 'sku', v_item.sku, 'tracking_no', v_site_no);
      end if;
      select * into v_item from app.items where id = v_item.id;
    end if;
    if v_status is null and trim(coalesce(v_item.tracking_no, '')) <> trim(coalesce(v_site_no, '')) then
      v_status := '追跡番号不一致';
    end if;
  end if;

  if v_status is not null then
    insert into app.marketplace_tracking_tasks
      (marketplace, account_label, marketplace_item_id, sku, app_tracking_no,
       site_tracking_no, confirmation_status, details)
    values (p_marketplace, coalesce(p_account_label, ''), v_item_id, v_item.sku,
      nullif(trim(v_item.tracking_no), ''), v_site_no, v_status, p_details)
    on conflict (marketplace, account_label, (coalesce(marketplace_item_id, sku, '')), confirmation_status)
      where state = '未確認'
    do update set sku = excluded.sku, app_tracking_no = excluded.app_tracking_no,
      site_tracking_no = excluded.site_tracking_no, details = excluded.details, updated_at = now();
    return jsonb_build_object('result', 'task_created', 'status', v_status, 'sku', v_item.sku);
  end if;

  update app.marketplace_tracking_tasks set state = '確認済み', updated_at = now()
  where (marketplace = p_marketplace or (p_marketplace in ('ヤフフリ', 'PayPayフリマ') and marketplace in ('ヤフフリ', 'PayPayフリマ'))) and marketplace_item_id = v_item_id and account_label = coalesce(p_account_label, '') and state = '未確認' and confirmation_status in ('追跡番号不一致','在庫未一致','在庫ID重複','追跡番号未取得');
  return jsonb_build_object('result', 'already_matched', 'sku', v_item.sku);
end;
$function$;
