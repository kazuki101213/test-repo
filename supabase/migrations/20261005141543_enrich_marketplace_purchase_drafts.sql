alter table app.marketplace_purchase_drafts
  add column if not exists product_id uuid references app.products(id) on delete set null,
  add column if not exists model_no text,
  add column if not exists product_no integer,
  add column if not exists asin char(10),
  add column if not exists planned_price bigint,
  add column if not exists planned_payout bigint;

create or replace function app.extension_probe_purchase_item(
  p_marketplace text, p_marketplace_item_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
  if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') then raise exception '対象外の仕入先です'; end if;
  if nullif(btrim(p_marketplace_item_id),'') is null or length(p_marketplace_item_id)>200 then raise exception '商品IDが不正です'; end if;
  select count(*) into v_count from app.items i
    where i.marketplace_item_id=btrim(p_marketplace_item_id)
      and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')));
  return jsonb_build_object('matched',v_count>0,'count',v_count);
end $$;
revoke all on function app.extension_probe_purchase_item(text,text) from public, anon;
grant execute on function app.extension_probe_purchase_item(text,text) to authenticated;

create or replace function app.extension_sync_purchase_drafts(
  p_marketplace text, p_account_label text, p_purchases jsonb, p_stop_on_match boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  inserted_count integer := 0;
  refreshed_count integer := 0;
  matched_item_ids text[] := array[]::text[];
  v_id text;
  v_title text;
  v_url text;
  v_price bigint;
  v_date date;
  v_model_no text;
  v_product_id uuid;
  v_product_no integer;
  v_asin char(10);
  v_planned_price bigint;
  v_planned_payout bigint;
  v_best_model_length integer;
  v_best_model_count integer;
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
      or (p_marketplace='ヤフオク' and v_url !~ '^https://(auctions|page\.auctions|contact\.auctions|buy\.auctions)\.yahoo\.co\.jp/')
      or (p_marketplace in ('ヤフフリ','PayPayフリマ') and v_url !~ '^https://paypayfleamarket(-sec)?\.yahoo\.co\.jp/')
      or (p_marketplace='ラクマ' and v_url !~ '^https://(www\.)?fril\.jp/' and v_url !~ '^https://item\.fril\.jp/') then continue; end if;

    v_product_id := null; v_model_no := null; v_product_no := null; v_asin := null;
    v_planned_price := null; v_planned_payout := null; v_best_model_length := null; v_best_model_count := 0;
    select max(length(btrim(p.model_no))) into v_best_model_length
      from app.products p
      where p.is_active and nullif(btrim(p.model_no),'') is not null
        and position(lower(btrim(p.model_no)) in lower(v_title))>0;
    if v_best_model_length is not null then
      select count(*) into v_best_model_count from app.products p
        where p.is_active and nullif(btrim(p.model_no),'') is not null
          and length(btrim(p.model_no))=v_best_model_length
          and position(lower(btrim(p.model_no)) in lower(v_title))>0;
      if v_best_model_count=1 then
        select p.id,p.model_no,p.product_no,p.asin,p.list_price,p.payout_estimate
          into v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout
          from app.products p
          where p.is_active and nullif(btrim(p.model_no),'') is not null
            and length(btrim(p.model_no))=v_best_model_length
            and position(lower(btrim(p.model_no)) in lower(v_title))>0
          limit 1;
      end if;
    end if;

    select i.id into v_existing_item from app.items i
      where i.marketplace_item_id=v_id
        and (i.marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and i.marketplace in ('ヤフフリ','PayPayフリマ')))
      order by i.created_at desc limit 1;
    if v_existing_item is not null then
      insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,state,registered_item_id,product_id,model_no,product_no,asin,planned_price,planned_payout)
        values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,
          case when coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then (row_data->>'purchased_at')::date else null end,
          case when coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then (row_data->>'cost_amount')::bigint else null end,
          'registered',v_existing_item,v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout)
        on conflict(marketplace,marketplace_item_id) do nothing;
      matched_item_ids := array_append(matched_item_ids,v_id);
      if p_stop_on_match then exit; end if;
      continue;
    end if;

    v_price := null;
    if coalesce(row_data->>'cost_amount','') ~ '^\d{1,10}$' then v_price := (row_data->>'cost_amount')::bigint; end if;
    v_date := null;
    if coalesce(row_data->>'purchased_at','') ~ '^\d{4}-\d{2}-\d{2}$' then v_date := (row_data->>'purchased_at')::date; end if;
    insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount,product_id,model_no,product_no,asin,planned_price,planned_payout)
      values(p_marketplace,v_id,v_url,btrim(p_account_label),v_title,v_date,v_price,v_product_id,v_model_no,v_product_no,v_asin,v_planned_price,v_planned_payout)
      on conflict(marketplace,marketplace_item_id) do update set
        marketplace_url=excluded.marketplace_url,
        account_label=excluded.account_label,
        title=excluded.title,
        purchased_at=coalesce(excluded.purchased_at,app.marketplace_purchase_drafts.purchased_at),
        cost_amount=coalesce(excluded.cost_amount,app.marketplace_purchase_drafts.cost_amount),
        product_id=coalesce(excluded.product_id,app.marketplace_purchase_drafts.product_id),
        model_no=coalesce(excluded.model_no,app.marketplace_purchase_drafts.model_no),
        product_no=coalesce(excluded.product_no,app.marketplace_purchase_drafts.product_no),
        asin=coalesce(excluded.asin,app.marketplace_purchase_drafts.asin),
        planned_price=coalesce(excluded.planned_price,app.marketplace_purchase_drafts.planned_price),
        planned_payout=coalesce(excluded.planned_payout,app.marketplace_purchase_drafts.planned_payout),
        last_seen_at=now()
      where app.marketplace_purchase_drafts.state='draft'
      returning (xmax=0) into was_inserted;
    if found then
      if was_inserted then inserted_count := inserted_count+1;
      else refreshed_count := refreshed_count+1; end if;
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted_count,'refreshed',refreshed_count,'matched_item_ids',to_jsonb(matched_item_ids));
end $$;
revoke all on function app.extension_sync_purchase_drafts(text,text,jsonb,boolean) from public, anon;
grant execute on function app.extension_sync_purchase_drafts(text,text,jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
