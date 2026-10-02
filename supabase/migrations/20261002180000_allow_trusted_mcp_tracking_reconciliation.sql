-- Allow the trusted Supabase operations connection (Postgres role) to invoke
-- the same guarded reconciliation RPC. PostgREST clients remain admin-only.
create or replace function app.reconcile_marketplace_tracking(
  p_marketplace app.marketplace,
  p_account_label text,
  p_marketplace_item_id text,
  p_site_tracking_no text,
  p_confirmation_status text default null,
  p_details text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = app, public
as $$
declare
  v_count integer;
  v_item app.items%rowtype;
  v_status text;
begin
  if not (
    current_user in ('postgres', 'service_role')
    or (auth.uid() is not null and app.current_role() = 'admin')
  ) then
    raise exception '管理者または信頼済み運用接続が必要です';
  end if;
  if nullif(trim(p_marketplace_item_id), '') is null then
    raise exception '商品IDが空です';
  end if;

  if p_confirmation_status in ('ログイン切れ', '追加承認待ち', '追跡番号未取得') then
    insert into app.marketplace_tracking_tasks
      (marketplace, account_label, marketplace_item_id, site_tracking_no, confirmation_status, details)
    values (p_marketplace, coalesce(p_account_label, ''), p_marketplace_item_id,
      nullif(trim(p_site_tracking_no), ''), p_confirmation_status, p_details);
    return jsonb_build_object('result', 'task_created');
  end if;

  select count(*)::integer into v_count from app.items
  where marketplace = p_marketplace and marketplace_item_id = p_marketplace_item_id;

  if v_count = 0 then v_status := '在庫未一致';
  elsif v_count > 1 then v_status := '在庫ID重複';
  else
    select * into v_item from app.items
    where marketplace = p_marketplace and marketplace_item_id = p_marketplace_item_id;
    if nullif(trim(p_site_tracking_no), '') is null then
      v_status := '追跡番号未取得';
    elsif nullif(trim(v_item.tracking_no), '') is null then
      update app.items set tracking_no = trim(p_site_tracking_no)
      where id = v_item.id and nullif(trim(tracking_no), '') is null;
      if found then
        return jsonb_build_object('result', 'updated', 'sku', v_item.sku, 'tracking_no', trim(p_site_tracking_no));
      end if;
      select * into v_item from app.items where id = v_item.id;
    end if;
    if v_status is null and trim(coalesce(v_item.tracking_no, '')) <> trim(coalesce(p_site_tracking_no, '')) then
      v_status := '追跡番号不一致';
    end if;
  end if;

  if v_status is not null then
    insert into app.marketplace_tracking_tasks
      (marketplace, account_label, marketplace_item_id, sku, app_tracking_no,
       site_tracking_no, confirmation_status, details)
    values (p_marketplace, coalesce(p_account_label, ''), p_marketplace_item_id,
      v_item.sku, nullif(trim(v_item.tracking_no), ''), nullif(trim(p_site_tracking_no), ''),
      v_status, p_details);
    return jsonb_build_object('result', 'task_created', 'status', v_status, 'sku', v_item.sku);
  end if;
  return jsonb_build_object('result', 'already_matched', 'sku', v_item.sku);
end;
$$;
