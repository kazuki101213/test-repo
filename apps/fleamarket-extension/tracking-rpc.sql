CREATE OR REPLACE FUNCTION app.reconcile_marketplace_tracking(p_marketplace app.marketplace, p_account_label text, p_marketplace_item_id text, p_site_tracking_no text, p_confirmation_status text DEFAULT NULL::text, p_details text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare
  v_count integer;
  v_item app.items%rowtype;
  v_status text;
  v_item_id text := nullif(trim(p_marketplace_item_id), '');
  v_site_no text := nullif(trim(p_site_tracking_no), '');
begin
  if not (
    current_user in ('postgres', 'service_role')
    or (auth.uid() is not null and app.current_role() = 'admin')
  ) then
    raise exception '管理者または信頼済み運用接続が必要です';
  end if;

  if p_confirmation_status in ('ログイン切れ', '追加承認待ち', 'アカウント未確認', '画面確認待ち', '評価結果要確認', '評価処理保留') then
    insert into app.marketplace_tracking_tasks
      (marketplace, account_label, marketplace_item_id, site_tracking_no, confirmation_status, details)
    values (p_marketplace, coalesce(p_account_label, ''), v_item_id, v_site_no, p_confirmation_status, p_details)
    on conflict (marketplace, account_label, (coalesce(marketplace_item_id, '')), confirmation_status)
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
    on conflict (marketplace, account_label, (coalesce(marketplace_item_id, '')), confirmation_status)
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
