create table app.amazon_fba_return_sync (
  account_id text primary key check (account_id in ('amazon-1','amazon-2')),
  import_from date not null,
  report_id text,
  requested_at timestamptz,
  last_completed_on date,
  completed_at timestamptz,
  last_error text,
  lease_id uuid,
  lease_until timestamptz,
  retry_at timestamptz
);

create table app.amazon_fba_customer_returns (
  account_id text not null references app.amazon_fba_return_sync(account_id),
  amazon_order_id text not null,
  source_sku text not null,
  returned_on date not null,
  quantity int not null check (quantity > 0),
  reason text,
  disposition text,
  amazon_status text,
  lpn text,
  item_id uuid unique references app.items(id) on delete set null,
  source_item_id uuid references app.items(id) on delete set null,
  registered_at timestamptz,
  review_reason text,
  updated_at timestamptz not null default now(),
  primary key (account_id,amazon_order_id,source_sku)
);

alter table app.amazon_fba_return_sync enable row level security;
alter table app.amazon_fba_customer_returns enable row level security;
revoke all on app.amazon_fba_return_sync, app.amazon_fba_customer_returns from public,anon,authenticated;
grant select,insert,update on app.amazon_fba_return_sync,app.amazon_fba_customer_returns to service_role;
grant select (account_id,requested_at,completed_at,last_error) on app.amazon_fba_return_sync to authenticated;
grant select (account_id,source_sku,returned_on,quantity,reason,disposition,amazon_status,review_reason,updated_at) on app.amazon_fba_customer_returns to authenticated;
create policy amazon_fba_return_sync_admin on app.amazon_fba_return_sync for select to authenticated using ((select app.is_admin()));
create policy amazon_fba_customer_returns_admin on app.amazon_fba_customer_returns for select to authenticated using ((select app.is_admin()));

create function app.claim_amazon_fba_return_sync(p_account_id text)
returns jsonb language plpgsql set search_path='' as $$
declare
  today date := (now() at time zone 'Asia/Tokyo')::date;
  job app.amazon_fba_return_sync;
begin
  insert into app.amazon_fba_return_sync(account_id, import_from)
  values(p_account_id,today-7) on conflict (account_id) do nothing;
  update app.amazon_fba_return_sync
  set lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes'
  where account_id=p_account_id and coalesce(lease_until,'-infinity')<=clock_timestamp()
    and coalesce(retry_at,'-infinity')<=clock_timestamp()
    and (report_id is not null or last_completed_on is distinct from today)
  returning * into job;
  if not found then return null; end if;
  return jsonb_build_object('lease_id',job.lease_id,'report_id',job.report_id,'requested_at',job.requested_at,
    'import_from',job.import_from,'report_from',today-30,'today',today);
end;
$$;

create function app.import_amazon_fba_customer_returns(p_account_id text,p_lease_id uuid,p_report_id text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  job app.amazon_fba_return_sync;
  shipment record;
  source_item app.items;
  saved app.amazon_fba_customer_returns;
  existing_id uuid;
  manual_count integer;
  imported integer:=0;
  linked integer:=0;
  review integer:=0;
  review_note text;
  source_channel text;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 then
    raise exception 'Amazon返品明細の形式が不正です' using errcode='22023';
  end if;
  select * into job from app.amazon_fba_return_sync where account_id=p_account_id
    and lease_id=p_lease_id and report_id=p_report_id and lease_until>clock_timestamp() for update;
  if not found then raise exception 'Amazon返品レポートの処理が更新されました'; end if;

  for shipment in select * from jsonb_to_recordset(p_rows) as r(
    amazon_order_id text, source_sku text, returned_on date, quantity int,
    reason text, disposition text, amazon_status text, lpn text, conflict boolean
  ) order by source_sku,amazon_order_id loop
    if shipment.returned_on<job.import_from then continue; end if;
    if coalesce(shipment.amazon_order_id,'') !~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
      or coalesce(length(btrim(shipment.source_sku)),0) not between 1 and 128
      or shipment.returned_on is null or shipment.returned_on>(now() at time zone 'Asia/Tokyo')::date
      or shipment.quantity is null or shipment.quantity<1
      or length(shipment.reason)>200 or length(shipment.disposition)>100
      or length(shipment.amazon_status)>100 or length(shipment.lpn)>100 then
      raise exception 'Amazon返品明細の識別情報を確認できません' using errcode='22023';
    end if;
    select * into saved from app.amazon_fba_customer_returns
    where account_id=p_account_id and amazon_order_id=shipment.amazon_order_id and source_sku=shipment.source_sku;
    if saved.registered_at is not null then continue; end if;

    select i.* into source_item from app.items i
    where not i.is_accessory and i.sku~'^[0-9]+[a-z]*[-_].+$'
      and (i.sku=shipment.source_sku or i.id=(select a.item_id from app.item_sku_aliases a where a.sku=shipment.source_sku))
    order by (i.sku=shipment.source_sku) desc limit 1;
    source_channel:=case p_account_id when 'amazon-1' then 'FBA1' else 'FBA2' end;
    review_note:=case
      when shipment.conflict then '同じ注文・SKUの返品明細が複数あります'
      when shipment.quantity<>1 then 'SKUの返品数量が1点ではありません'
      when source_item.id is null then '元商品をSKUで照合できません'
      when not coalesce(source_item.sales_channel::text=source_channel
        or (p_account_id='amazon-1' and source_item.sales_channel::text='FBA'),false)
        then '元商品のAmazonアカウントを照合できません'
      when source_item.deliverer_id is null or source_item.purchaser_id is null or nullif(btrim(source_item.title),'') is null
        then '元商品の担当者または商品名が未登録です'
      else null end;
    existing_id:=null;
    if review_note is null then
      -- This is the same per-lot lock used by the existing a/aa SKU trigger.
      perform pg_advisory_xact_lock(hashtextextended('amazon-return:' || source_item.lot_seq::text || ':' ||
        (regexp_match(source_item.sku,'^([0-9]+)'))[1],179049));
      select i.* into source_item from app.items i where i.id=source_item.id and not i.is_accessory
        and (i.sku=shipment.source_sku or exists(select 1 from app.item_sku_aliases a where a.sku=shipment.source_sku and a.item_id=i.id))
        and (i.sales_channel::text=source_channel or (p_account_id='amazon-1' and i.sales_channel::text='FBA')) for update;
      if not found then review_note:='元商品の販売先が変わったため確認が必要です'; end if;
    end if;
    if review_note is null then
      select count(*),(array_agg(i.id))[1] into manual_count,existing_id from app.items i
      where i.lot_seq=source_item.lot_seq and i.id<>source_item.id and not i.is_accessory
        and i.marketplace='Amazon返品' and i.amazon_returned_on=shipment.returned_on
        and (i.sales_channel::text=source_channel or (p_account_id='amazon-1' and i.sales_channel::text='FBA'))
        and not exists(select 1 from app.amazon_fba_customer_returns x where x.item_id=i.id);

      if manual_count>1 then
        review_note:='同じ返品日の手入力済みの返品が複数あります';
      elsif manual_count=1 then
        linked:=linked+1;
      elsif exists(
        select 1 from app.items i
        where i.lot_seq=source_item.lot_seq and i.id<>source_item.id and not i.is_accessory
          and i.marketplace='Amazon返品' and i.amazon_returned_on is null
          and (i.created_at at time zone 'Asia/Tokyo')::date between shipment.returned_on-30 and shipment.returned_on+30
          and not exists(select 1 from app.amazon_fba_customer_returns x where x.item_id=i.id)
      ) then
        review_note:='同じ通番号に返品日未入力の返品登録があります';
      else
        begin
          insert into app.items(sku,lot_seq,purchaser_id,deliverer_id,work_stream,title,cost_amount,
            marketplace,marketplace_item_id,marketplace_url,product_id,asin,condition,
            planned_price,planned_payout,sales_channel,amazon_returned_on,return_reason)
          values(source_item.sku,source_item.lot_seq,source_item.purchaser_id,source_item.deliverer_id,source_item.work_stream,
            source_item.title,0,'Amazon返品',source_item.marketplace_item_id,source_item.marketplace_url,
            source_item.product_id,source_item.asin,source_item.condition,
            source_item.planned_price,source_item.planned_payout,source_item.sales_channel,shipment.returned_on,nullif(shipment.reason,''))
          returning id into existing_id;
          imported:=imported+1;
        exception when unique_violation then
          review_note:='返品用のSKUが既存の在庫と重複しました';
        end;
      end if;
    end if;
    if review_note is not null then review:=review+1; existing_id:=null; end if;
    insert into app.amazon_fba_customer_returns(account_id,amazon_order_id,source_sku,returned_on,quantity,
      reason,disposition,amazon_status,lpn,item_id,source_item_id,review_reason,registered_at)
    values (p_account_id,shipment.amazon_order_id,shipment.source_sku,shipment.returned_on,shipment.quantity,
      shipment.reason,shipment.disposition,shipment.amazon_status,shipment.lpn,existing_id,source_item.id,review_note,
      case when existing_id is not null then now() end)
    on conflict(account_id,amazon_order_id,source_sku) do update
    set returned_on=excluded.returned_on,quantity=excluded.quantity,reason=excluded.reason,
      disposition=excluded.disposition,amazon_status=excluded.amazon_status,lpn=excluded.lpn,
      item_id=excluded.item_id,source_item_id=excluded.source_item_id,review_reason=excluded.review_reason,
      registered_at=excluded.registered_at,updated_at=now();
  end loop;
  return jsonb_build_object('imported',imported,'linked',linked,'review',review);
end;
$$;

revoke all on function app.claim_amazon_fba_return_sync(text),app.import_amazon_fba_customer_returns(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function app.claim_amazon_fba_return_sync(text),app.import_amazon_fba_customer_returns(text,uuid,text,jsonb) to service_role;

select cron.schedule('amazon-fba-return-sync', '15 * * * *', $job$
  select net.http_post(
    url := rtrim(config.project_url,'/') || '/functions/v1/amazon-fba-returns',
    headers := jsonb_build_object('Content-Type','application/json','x-amazon-cron-token',config.token),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  from (
    select
      (select decrypted_secret from vault.decrypted_secrets where name='delivery_push_project_url') project_url,
      (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token') token
  ) config
  where config.project_url is not null and config.token is not null;
$job$);

notify pgrst, 'reload schema';
