-- Account-level access failures have no listing ID. Keep that field genuinely
-- empty instead of inventing a fake marketplace item ID, and deduplicate open tasks.
alter table app.marketplace_tracking_tasks alter column marketplace_item_id drop not null;
create unique index if not exists marketplace_tracking_tasks_open_unique
  on app.marketplace_tracking_tasks
    (marketplace, account_label, (coalesce(marketplace_item_id, '')), confirmation_status)
  where state = '未確認';

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
  v_item_id text := nullif(trim(p_marketplace_item_id), '');
  v_site_no text := nullif(trim(p_site_tracking_no), '');
begin
  if not (
    current_user in ('postgres', 'service_role')
    or (auth.uid() is not null and app.current_role() = 'admin')
  ) then
    raise exception '管理者または信頼済み運用接続が必要です';
  end if;

  if p_confirmation_status in ('ログイン切れ', '追加承認待ち') then
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

  select count(*)::integer into v_count from app.items
  where marketplace = p_marketplace and marketplace_item_id = v_item_id;

  if v_count = 0 then v_status := '在庫未一致';
  elsif v_count > 1 then v_status := '在庫ID重複';
  else
    select * into v_item from app.items
    where marketplace = p_marketplace and marketplace_item_id = v_item_id;
    if v_site_no is null then
      v_status := '追跡番号未取得';
    elsif nullif(trim(v_item.tracking_no), '') is null then
      update app.items set tracking_no = v_site_no
      where id = v_item.id and nullif(trim(tracking_no), '') is null;
      if found then
        update app.marketplace_tracking_tasks set state = '確認済み', updated_at = now()
        where marketplace = p_marketplace and marketplace_item_id = v_item_id and account_label = coalesce(p_account_label, '') and state = '未確認';
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
  where marketplace = p_marketplace and marketplace_item_id = v_item_id and account_label = coalesce(p_account_label, '') and state = '未確認';
  return jsonb_build_object('result', 'already_matched', 'sku', v_item.sku);
end;
$$;
