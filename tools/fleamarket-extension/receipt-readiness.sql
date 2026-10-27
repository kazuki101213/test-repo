-- Receipt-only readiness. Tracking continues to use the unchanged exact-one probe.
create or replace function app.marketplace_receipt_context(p_marketplace app.marketplace,p_item_id text)
returns jsonb language plpgsql security invoker set search_path=app,public as $$
declare v_probe jsonb; v_items jsonb;
begin
  v_probe=app.marketplace_extension_probe(p_marketplace,p_item_id);
  select coalesce(jsonb_agg(e.value || jsonb_build_object(
    'receipt_ready', (i.inspected_at is not null and i.cleaned_at is not null) or
      (i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null),
    'receipt_source', case when i.inspected_at is not null and i.cleaned_at is not null then 'own'
      when i.is_accessory and p.id is not null and not p.is_accessory and p.id<>i.id and p.inspected_at is not null and p.cleaned_at is not null then 'parent' else null end,
    'receipt_parent_sku', case when i.is_accessory and p.id is not null and not p.is_accessory then p.sku else null end
  ) order by i.id),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_probe->'items') e(value)
  join app.items i on i.id=(e.value->>'id')::uuid
  left join app.items p on i.is_accessory and p.id=i.parent_item_id;
  return v_probe || jsonb_build_object('items',v_items);
end $$;
revoke all on function app.marketplace_receipt_context(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_receipt_context(app.marketplace,text) to authenticated;

CREATE OR REPLACE FUNCTION app.marketplace_extension_receipt(p_action text, p_marketplace app.marketplace, p_item_id text, p_account_label text, p_token uuid DEFAULT NULL::uuid, p_details text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare v_market text; v_probe jsonb; v_row app.marketplace_extension_receipts%rowtype; v_token uuid;
begin
  if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です'; end if;
  if p_action not in ('reserve','begin','complete','unknown','release') then raise exception '操作が不正です'; end if;
  if nullif(trim(p_account_label),'') is null or length(p_account_label)>200 then raise exception 'アカウント識別が必要です'; end if;
  v_probe=app.marketplace_receipt_context(p_marketplace,p_item_id);
  v_market=case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end;
  perform pg_advisory_xact_lock(hashtextextended(v_market||':'||p_item_id,0));
  select * into v_row from app.marketplace_extension_receipts where marketplace=v_market and marketplace_item_id=p_item_id for update;
  if p_action='reserve' then
    if (v_probe->>'count')::int<>1 then return jsonb_build_object('eligible',false,'reason','在庫1件一致が必要です'); end if;
    if coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then return jsonb_build_object('eligible',false,'reason','検品・清掃の記録待ち'); end if;
    if v_row.state is not null then return jsonb_build_object('eligible',false,'reason','既存の評価記録: '||v_row.state); end if;
    insert into app.marketplace_extension_receipts(marketplace,marketplace_item_id,account_label,state,reserved_by)
      values(v_market,p_item_id,p_account_label,'reserved',auth.uid()) returning token into v_token;
    return jsonb_build_object('eligible',true,'token',v_token,'sku',v_probe->'items'->0->>'sku');
  end if;
  if v_row.token is distinct from p_token or v_row.reserved_by is distinct from auth.uid() or v_row.account_label<>p_account_label then raise exception '評価予約が一致しません'; end if;
  if p_action='begin' then
    if v_row.state<>'reserved' or v_row.reserved_at<now()-interval '5 minutes' then raise exception '評価予約が期限切れか送信済みです'; end if;
    if (v_probe->>'count')::int<>1 or coalesce((v_probe->'items'->0->>'receipt_ready')::boolean,false) is not true then raise exception '評価条件が変わりました'; end if;
    update app.marketplace_extension_receipts set state='submitting',updated_at=now() where token=p_token;
  elsif p_action='release' then
    if v_row.state<>'reserved' then raise exception '送信開始後は予約を解除できません'; end if;
    delete from app.marketplace_extension_receipts where token=p_token;
  elsif p_action in ('complete','unknown') then
    if v_row.state not in ('submitting','unknown') then raise exception '送信状態が不正です'; end if;
    update app.marketplace_extension_receipts set state=case when p_action='complete' then 'succeeded' else 'unknown' end,details=left(p_details,2000),updated_at=now() where token=p_token;
  end if;
  return jsonb_build_object('ok',true);
end $function$
