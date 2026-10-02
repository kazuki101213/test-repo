-- Marketplace tracking reconciliation tasks and guarded update RPC.
create table if not exists app.marketplace_tracking_tasks (
  id uuid primary key default gen_random_uuid(),
  marketplace app.marketplace not null,
  account_label text not null default '',
  marketplace_item_id text not null,
  sku text,
  app_tracking_no text,
  site_tracking_no text,
  confirmation_status text not null check (confirmation_status in (
    '追跡番号不一致', '在庫未一致', '在庫ID重複', '追跡番号未取得', 'ログイン切れ', '追加承認待ち'
  )),
  details text,
  state text not null default '未確認' check (state in ('未確認', '確認済み')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_tracking_tasks_open_idx
  on app.marketplace_tracking_tasks (state, created_at desc);

alter table app.marketplace_tracking_tasks enable row level security;
grant select, insert, update on app.marketplace_tracking_tasks to authenticated;
drop policy if exists marketplace_tracking_tasks_admin on app.marketplace_tracking_tasks;
create policy marketplace_tracking_tasks_admin on app.marketplace_tracking_tasks
  for all to authenticated
  using (app.current_role() = 'admin')
  with check (app.current_role() = 'admin');

-- Apply only when the marketplace item ID identifies exactly one inventory row,
-- the stored marketplace agrees, and the app tracking field is currently empty.
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
  if auth.uid() is null or app.current_role() <> 'admin' then
    raise exception '管理者ログインが必要です';
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

  select count(*)::integer into v_count
  from app.items
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

revoke all on function app.reconcile_marketplace_tracking(app.marketplace, text, text, text, text, text) from public;
grant execute on function app.reconcile_marketplace_tracking(app.marketplace, text, text, text, text, text) to authenticated;
