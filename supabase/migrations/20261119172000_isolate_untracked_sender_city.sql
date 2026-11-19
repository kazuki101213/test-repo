alter table app.items
  add column if not exists untracked_sender_name text,
  add column if not exists untracked_sender_prefecture_city text;

do $migration$
declare
  definition text;
  old text;
  new text;
begin
  definition := pg_get_viewdef('app.v_inventory_display'::regclass, true);
  if strpos(definition, 'AS untracked_sender_prefecture_city') = 0 then
    old := E'raw.untracked_shipping_method\n';
    new := E'raw.untracked_shipping_method,\n        CASE WHEN app.current_role() IN (''admin'',''purchaser'') THEN raw.untracked_sender_name END AS untracked_sender_name,\n        CASE WHEN app.current_role() IN (''admin'',''purchaser'') THEN raw.untracked_sender_prefecture_city END AS untracked_sender_prefecture_city\n';
    if strpos(definition, old) = 0 then
      raise exception 'v_inventory_display shipping projection anchor is missing';
    end if;
    execute 'create or replace view app.v_inventory_display as ' || replace(definition, old, new);
  end if;

  definition := pg_get_viewdef('app.v_items'::regclass, true);
  old := E'NULL::text AS untracked_shipping_method\n   FROM app.items i';
  new := E'NULL::text AS untracked_shipping_method,\n    NULL::text AS untracked_sender_prefecture_city\n   FROM app.items i';
  if strpos(definition, old) > 0 then
    new := E'NULL::text AS untracked_shipping_method,\n    NULL::text AS untracked_sender_name,\n    NULL::text AS untracked_sender_prefecture_city\n   FROM app.items i';
    execute 'create or replace view app.v_items as ' || replace(definition, old, new);
  elsif strpos(definition, 'AS untracked_sender_prefecture_city') = 0 then
    old := E'i.updated_at\n   FROM app.items i';
    new := E'i.updated_at,\n    NULL::text AS seller_name,\n    NULL::text AS seller_address,\n    NULL::text AS untracked_shipping_method,\n    NULL::text AS untracked_sender_name,\n    NULL::text AS untracked_sender_prefecture_city\n   FROM app.items i';
    if strpos(definition, old) = 0 then
      raise exception 'v_items security projection anchor is missing';
    end if;
    execute 'create or replace view app.v_items as ' || replace(definition, old, new);
  end if;
end
$migration$;

create or replace function app.record_untracked_shipping_sender(
  p_marketplace_item_id text,
  p_account_label text,
  p_sender_name text,
  p_sender_prefecture_city text,
  p_shipping_method text
) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, app
as $function$
declare
  v_item app.items%rowtype;
  v_count integer;
  v_name text := nullif(btrim(p_sender_name), '');
  v_city text := nullif(btrim(p_sender_prefecture_city), '');
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  if p_account_label not in ('ヤフオク1', 'ヤフオク2')
    or p_shipping_method <> '定形外郵便'
    or v_name is null or length(v_name) > 100 or v_name ~ E'[\\r\\n]'
    or v_city is null or length(v_city) > 40
    or v_city !~ '^(北海道|東京都|京都府|大阪府|.{2,3}県)[^0-9０-９]{1,15}(市|区|町|村)$' then
    raise exception '定形外郵便の発送者情報が不正です' using errcode = '22023';
  end if;

  select count(*)::integer into v_count
  from app.items where marketplace = 'ヤフオク' and marketplace_item_id = p_marketplace_item_id;
  if v_count <> 1 then
    return jsonb_build_object('result', case when v_count = 0 then 'not_found' else 'ambiguous' end, 'count', v_count);
  end if;

  select * into v_item from app.items
  where marketplace = 'ヤフオク' and marketplace_item_id = p_marketplace_item_id
  for update;

  if nullif(btrim(v_item.tracking_no), '') is not null or v_item.sold_on is not null
    or v_item.status in ('販売済', '返品処理') then
    return jsonb_build_object('result', 'not_eligible', 'sku', v_item.sku);
  end if;
  if (v_item.untracked_sender_name is not null and v_item.untracked_sender_name <> v_name)
    or (v_item.untracked_sender_prefecture_city is not null and v_item.untracked_sender_prefecture_city <> v_city)
    or (v_item.untracked_shipping_method is not null and v_item.untracked_shipping_method <> p_shipping_method) then
    return jsonb_build_object('result', 'conflict', 'sku', v_item.sku);
  end if;
  if v_item.untracked_sender_name = v_name and v_item.untracked_sender_prefecture_city = v_city
    and v_item.untracked_shipping_method = p_shipping_method then
    return jsonb_build_object('result', 'already_recorded', 'sku', v_item.sku);
  end if;

  update app.items
  set untracked_sender_name = v_name,
      untracked_sender_prefecture_city = v_city,
      untracked_shipping_method = p_shipping_method
  where id = v_item.id;

  return jsonb_build_object('result', 'recorded', 'sku', v_item.sku);
end
$function$;

revoke all on function app.record_untracked_shipping_sender(text,text,text,text,text) from public, anon;
grant execute on function app.record_untracked_shipping_sender(text,text,text,text,text) to authenticated;
notify pgrst, 'reload schema';
