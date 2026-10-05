create table if not exists app.marketplace_purchase_drafts (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  marketplace_item_id text not null,
  marketplace_url text not null,
  account_label text not null,
  title text not null,
  purchased_at date,
  cost_amount bigint,
  state text not null default 'draft' check (state in ('draft','registered','dismissed')),
  registered_item_id uuid references app.items(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (marketplace, marketplace_item_id)
);

alter table app.items add column if not exists source_purchase_draft_id uuid
  references app.marketplace_purchase_drafts(id) on delete set null;
create unique index if not exists items_source_purchase_draft_unique
  on app.items(source_purchase_draft_id) where source_purchase_draft_id is not null;

alter table app.marketplace_purchase_drafts enable row level security;
revoke all on app.marketplace_purchase_drafts from anon, authenticated;
grant select, update on app.marketplace_purchase_drafts to authenticated;
drop policy if exists marketplace_purchase_drafts_admin_read on app.marketplace_purchase_drafts;
create policy marketplace_purchase_drafts_admin_read on app.marketplace_purchase_drafts
  for select to authenticated using (app.is_admin());
drop policy if exists marketplace_purchase_drafts_admin_update on app.marketplace_purchase_drafts;
create policy marketplace_purchase_drafts_admin_update on app.marketplace_purchase_drafts
  for update to authenticated using (app.is_admin()) with check (app.is_admin());

create or replace function app.extension_sync_purchase_drafts(
  p_marketplace text, p_account_label text, p_purchases jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  inserted_count integer := 0;
  refreshed_count integer := 0;
  v_id text;
  v_title text;
  v_url text;
  v_price bigint;
  v_date date;
  was_inserted boolean;
  v_existing_item uuid;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_account_label),'') is null or length(p_account_label)>120 then raise exception 'アカウント名が不正です'; end if;
  if jsonb_typeof(p_purchases)<>'array' or jsonb_array_length(p_purchases)>500 then raise exception '購入履歴の形式または件数が不正です'; end if;
  for row_data in select value from jsonb_array_elements(p_purchases) loop
    v_id := nullif(btrim(row_data->>'marketplace_item_id'),'');
    v_title := nullif(btrim(row_data->>'title'),'');
    v_url := nullif(btrim(row_data->>'marketplace_url'),'');
    if v_id is null or v_title is null or v_url is null or length(v_id)>200 or length(v_title)>500 or length(v_url)>2000 then continue; end if;
    if (p_marketplace='メルカリ' and v_url !~ '^https://jp\.mercari\.com/')
      or (p_marketplace='ヤフオク' and v_url !~ '^https://(auctions|contact\.auctions|buy\.auctions)\.yahoo\.co\.jp/')
      or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_url !~ '^https://paypayfleamarket\.yahoo\.co\.jp/')
      or (p_marketplace='ラクマ' and v_url !~ '^https://(www\.)?fril\.jp/') then continue; end if;
    v_existing_item := null;
    select i.id into v_existing_item from app.items i
      where i.marketplace_item_id=v_id
        and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
      order by i.created_at desc limit 1;
    if v_existing_item is not null then
      insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,state,registered_item_id)
        values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,
          case when coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then (row_data->>'purchased_at')::date else null end,
          case when coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then (row_data->>'cost_amount')::bigint else null end,
          'registered',v_existing_item)
        on conflict(marketplace,marketplace_item_id) do nothing;
      continue;
    end if;
    v_price := null;
    if coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then v_price := (row_data->>'cost_amount')::bigint; end if;
    v_date := null;
    if coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then v_date := (row_data->>'purchased_at')::date; end if;
    insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount)
      values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,v_date,v_price)
      on conflict(marketplace,marketplace_item_id) do update set
        marketplace_url=excluded.marketplace_url,
        account_label=excluded.account_label,
        title=excluded.title,
        purchased_at=coalesce(excluded.purchased_at,app.marketplace_purchase_drafts.purchased_at),
        cost_amount=coalesce(excluded.cost_amount,app.marketplace_purchase_drafts.cost_amount),
        last_seen_at=now()
      where app.marketplace_purchase_drafts.state='draft'
      returning (xmax=0) into was_inserted;
    if found then
      if was_inserted then inserted_count := inserted_count+1;
      else refreshed_count := refreshed_count+1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'refreshed',refreshed_count);
end $$;
revoke all on function app.extension_sync_purchase_drafts(text,text,jsonb) from public, anon;
grant execute on function app.extension_sync_purchase_drafts(text,text,jsonb) to authenticated;

create or replace function app.mark_purchase_draft_registered()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source_purchase_draft_id is not null then
    update app.marketplace_purchase_drafts set state='registered',registered_item_id=new.id
      where id=new.source_purchase_draft_id and state='draft';
    if not found then raise exception '仕入れリストが既に反映済みか、削除されています'; end if;
  end if;
  return new;
end $$;
drop trigger if exists items_mark_purchase_draft_registered on app.items;
create trigger items_mark_purchase_draft_registered after insert on app.items
  for each row execute function app.mark_purchase_draft_registered();

comment on table app.marketplace_purchase_drafts is 'Chrome拡張機能で同期したフリマ購入履歴の下書き。仕入れリスト画面で確認してから在庫へ反映する。';
