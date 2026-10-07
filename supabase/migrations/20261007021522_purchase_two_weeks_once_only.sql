create or replace function app.marketplace_purchase_context(p_marketplace text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date; v_ids jsonb; v_inventory_ids jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  select coalesce(jsonb_agg(distinct id),'[]'::jsonb) into v_ids from (
    select marketplace_item_id as id from app.items where marketplace_item_id is not null
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))
    union select marketplace_item_id from app.marketplace_purchase_drafts
      where (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))
  ) known;
  select coalesce(jsonb_agg(distinct marketplace_item_id),'[]'::jsonb) into v_inventory_ids from app.items where marketplace_item_id is not null and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'));
  return jsonb_build_object('inventoryIds',v_inventory_ids,'day',v_day,'cutoff',(v_day-14),'knownIds',v_ids);
end $$;
revoke all on function app.marketplace_purchase_context(text) from public,anon;
grant execute on function app.marketplace_purchase_context(text) to authenticated;

create or replace function app.marketplace_purchase_import(p_marketplace text,p_account_label text,p_purchases jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_site text := case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_cutoff date := (v_day-14); r jsonb; v_id text; v_date date;
  v_inserted int := 0; v_refreshed int := 0; v_skipped int := 0; v_rejected int := 0; v_result jsonb;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if p_purchases is null or jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then
    raise exception '購入履歴の形式または件数が不正です'; end if;
  for r in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(r->>'marketplace_item_id'),''); v_date := null;
    begin
      if coalesce(r->>'purchased_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then v_date := (r->>'purchased_at')::date; end if;
    exception when datetime_field_overflow or invalid_datetime_format then v_date := null; end;
    if coalesce((r->>'cancelled')::boolean,false) or v_id is null or v_date is null or v_date<v_cutoff or v_date>v_day then v_rejected:=v_rejected+1; continue; end if;
    if r->>'marketplace_url' <> (case v_site when 'メルカリ' then 'https://jp.mercari.com/item/' when 'ヤフオク' then 'https://auctions.yahoo.co.jp/jp/auction/' when 'ヤフフリ' then 'https://paypayfleamarket.yahoo.co.jp/item/' when 'ラクマ' then 'https://item.fril.jp/' end || v_id) then v_rejected:=v_rejected+1; continue; end if;
    if exists(select 1 from app.items where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ')))
      or exists(select 1 from app.marketplace_purchase_drafts where marketplace_item_id=v_id
      and (marketplace::text=v_site or (v_site='ヤフフリ' and marketplace='PayPayフリマ'))) then
      v_skipped:=v_skipped+1; continue; end if;
    v_result := app.extension_sync_purchase_drafts(v_site,p_account_label,jsonb_build_array(r),false);
    if coalesce((v_result->>'inserted')::int,0)>0 then v_inserted:=v_inserted+1;
    elsif coalesce((v_result->>'refreshed')::int,0)>0 then v_refreshed:=v_refreshed+1; v_skipped:=v_skipped+1;
    elsif jsonb_array_length(coalesce(v_result->'matched_item_ids','[]'::jsonb))>0 then v_skipped:=v_skipped+1;
    else v_rejected:=v_rejected+1; end if;
  end loop;
  return jsonb_build_object('inserted',v_inserted,'refreshed',v_refreshed,'skipped',v_skipped,'rejected',v_rejected);
end $$;
revoke all on function app.marketplace_purchase_import(text,text,jsonb) from public,anon;
grant execute on function app.marketplace_purchase_import(text,text,jsonb) to authenticated;
notify pgrst,'reload schema';
