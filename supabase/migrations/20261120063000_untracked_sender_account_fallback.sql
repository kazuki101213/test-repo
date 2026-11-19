-- 追跡番号なし郵便（定形外・普通郵便）の表示ルール（2026-11-20 利用者指定）
--   氏名と住所が分かる場合：定形外郵便（氏名、住所）
--   分からない・匿名の場合：定形外郵便（相手のアカウント名）
-- メルカリは購入者画面に出品者の氏名・住所を出さないため、アカウント名で記録できるようにする。
alter table app.items add column if not exists untracked_sender_account text;

do $migration$
declare
  definition text;
  old text;
  new text;
begin
  definition := pg_get_viewdef('app.v_inventory_display'::regclass, true);
  if strpos(definition, 'AS untracked_sender_account') = 0 then
    old := E'END AS untracked_sender_name\n';
    new := E'END AS untracked_sender_name,\n        CASE WHEN app.current_role() IN (''admin'',''purchaser'') THEN raw.untracked_sender_account END AS untracked_sender_account\n';
    if length(definition) - length(replace(definition, old, '')) <> length(old) then
      raise exception 'v_inventory_display sender name anchor is missing or ambiguous';
    end if;
    execute 'create or replace view app.v_inventory_display as ' || replace(definition, old, new);
  end if;

  definition := pg_get_viewdef('app.v_items'::regclass, true);
  if strpos(definition, 'AS untracked_sender_account') = 0 then
    old := E'NULL::text AS untracked_sender_name\n   FROM app.items i';
    new := E'NULL::text AS untracked_sender_name,\n    NULL::text AS untracked_sender_account\n   FROM app.items i';
    if strpos(definition, old) = 0 then
      raise exception 'v_items sender name anchor is missing';
    end if;
    execute 'create or replace view app.v_items as ' || replace(definition, old, new);
  end if;
end
$migration$;

create or replace function app.record_untracked_shipping_account(
  p_marketplace text,
  p_marketplace_item_id text,
  p_account_label text,
  p_sender_account text,
  p_shipping_method text
) returns jsonb
language plpgsql set search_path = pg_catalog, app
as $function$
declare
  v_item app.items%rowtype;
  v_count integer;
  v_account text := nullif(btrim(p_sender_account), '');
begin
  if current_user <> 'postgres' and (auth.uid() is null or not app.is_admin()) then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  if p_marketplace not in ('メルカリ', 'ヤフオク')
    or p_account_label not in ('メルカリ1', 'メルカリ2', 'ヤフオク1', 'ヤフオク2', '利用者提供画像')
    or p_shipping_method not in ('定形外郵便', '普通郵便')
    or v_account is null or length(v_account) > 100 or v_account ~ E'[\\r\\n]' then
    raise exception '追跡番号なし郵便のアカウント名が不正です' using errcode = '22023';
  end if;

  select count(*)::integer into v_count
  from app.items where marketplace::text = p_marketplace and marketplace_item_id = p_marketplace_item_id;
  if v_count <> 1 then
    return jsonb_build_object('result', case when v_count = 0 then 'not_found' else 'ambiguous' end, 'count', v_count);
  end if;

  select * into v_item from app.items
  where marketplace::text = p_marketplace and marketplace_item_id = p_marketplace_item_id
  for update;

  if nullif(btrim(v_item.tracking_no), '') is not null or v_item.sold_on is not null
    or v_item.status in ('販売済', '返品処理') then
    return jsonb_build_object('result', 'not_eligible', 'sku', v_item.sku);
  end if;
  if (v_item.untracked_shipping_method is not null and v_item.untracked_shipping_method <> p_shipping_method)
    or (v_item.untracked_sender_account is not null and v_item.untracked_sender_account <> v_account) then
    return jsonb_build_object('result', 'conflict', 'sku', v_item.sku);
  end if;
  if v_item.untracked_shipping_method = p_shipping_method and v_item.untracked_sender_account = v_account then
    return jsonb_build_object('result', 'already_recorded', 'sku', v_item.sku);
  end if;

  update app.items
  set untracked_shipping_method = p_shipping_method,
      untracked_sender_account = v_account
  where id = v_item.id;

  return jsonb_build_object('result', 'recorded', 'sku', v_item.sku);
end
$function$;

revoke all on function app.record_untracked_shipping_account(text, text, text, text, text) from public, anon;
grant execute on function app.record_untracked_shipping_account(text, text, text, text, text) to authenticated;
notify pgrst, 'reload schema';
