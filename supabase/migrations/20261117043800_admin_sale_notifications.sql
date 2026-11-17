create table app.sale_notices (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  item_id uuid references app.items(id) on delete set null,
  message text not null,
  created_at timestamptz not null default now()
);
alter table app.sale_notices enable row level security;
revoke all on app.sale_notices from public, anon, authenticated;

create table app.amazon_sale_poll (
  account_id text primary key check(account_id in ('amazon-1','amazon-2')),
  enabled_at timestamptz not null default now(),
  checked_through timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  last_success_at timestamptz
);
alter table app.amazon_sale_poll enable row level security;
revoke all on app.amazon_sale_poll from public, anon, authenticated;
grant select, update on app.amazon_sale_poll to service_role;
insert into app.amazon_sale_poll(account_id) values ('amazon-1'), ('amazon-2');

alter table app.admin_push_events drop constraint admin_push_events_kind_check;
alter table app.admin_push_events add constraint admin_push_events_kind_check
  check(kind in ('malfunction','action','photo_review','invoice','receipts','packing_photo','malfunction_message','sale'));

create function app.record_sale_notice(p_key text,p_item uuid,p_message text)
returns boolean language plpgsql security definer set search_path='' as $$
declare notice_id uuid;
begin
  if p_key is null or p_message is null or length(p_key) not between 3 and 400 or length(p_message) not between 1 and 250 then
    raise exception 'Invalid sale notice';
  end if;
  insert into app.sale_notices(source_key,item_id,message) values(p_key,p_item,p_message)
  on conflict(source_key) do nothing returning id into notice_id;
  if notice_id is null then return false; end if;
  perform app.enqueue_admin_push('sale',notice_id,p_item,null,null,null,now());
  return true;
end $$;

create function app.observe_fleamarket_sale_notice()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  label text;
  activation timestamptz;
  trade_at timestamptz;
  body text;
  serial text;
  sale_day date;
  amount text;
begin
  if new.observed_status is null or new.observed_status not in ('取引中','販売済')
     or old.observed_status in ('取引中','販売済') or new.trade_key is null then return new; end if;
  label := case new.account_id
    when 'mercari-1' then 'メルカリ1' when 'mercari-2' then 'メルカリ2'
    when 'auctions-1' then 'ヤフオク1' when 'auctions-2' then 'ヤフオク2'
  end;
  if label is null then return new; end if;
  select min(enabled_at) into activation from app.amazon_sale_poll;
  if new.observed_at < activation then return new; end if;
  if new.trade_key ~ '^[a-z][0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then
    trade_at := (split_part(new.trade_key,':',2)||':'||split_part(new.trade_key,':',3))::timestamp at time zone 'Asia/Tokyo';
    if trade_at < date_trunc('minute',activation) or trade_at > now()+interval '5 minutes' then return new; end if;
  elsif old.observed_status is null or old.observed_status not in ('出品中','支払い待ち','キャンセル') then
    return new;
  end if;
  sale_day := nullif(new.verified_sale->>'sold_on','')::date;
  if sale_day < (activation at time zone 'Asia/Tokyo')::date then return new; end if;
  if old.observed_status='キャンセル' and new.trade_key is not distinct from old.trade_key then return new; end if;
  select app.product_serial(i.sku,i.lot_seq),left(i.title,100) into serial,body from app.items i where id=new.item_id;
  amount := new.verified_sale->>'sold_price';
  perform app.record_sale_notice(jsonb_build_array(new.account_id,new.external_id,new.trade_key)::text,new.item_id,
    concat(label,'で売れました｜【',serial,'】',body,case when amount ~ '^[0-9]{1,9}$' then '｜'||to_char(amount::numeric,'FM999,999,990')||'円' end));
  return new;
exception when invalid_datetime_format or datetime_field_overflow then
  return new;
end $$;
create trigger seller_listings_sale_notice after update of observed_status on app.seller_listings
  for each row execute function app.observe_fleamarket_sale_notice();

create function app.claim_amazon_sale_poll(p_account text)
returns jsonb language sql security definer set search_path='' as $$
  update app.amazon_sale_poll p set lease_id=gen_random_uuid(),lease_until=now()+interval '4 minutes'
  where p.account_id=p_account and (p.lease_until is null or p.lease_until<now())
    and (p.next_attempt_at is null or p.next_attempt_at<=now())
  returning jsonb_build_object('lease',p.lease_id,'through',p.checked_through,'enabled',p.enabled_at);
$$;

create function app.record_amazon_sale_page(p_account text,p_lease uuid,p_rows jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare
  activation timestamptz;
  item app.items;
  r record;
  channel text;
  label text;
  queued integer:=0;
  item_price text;
begin
  select enabled_at into strict activation from app.amazon_sale_poll
  where account_id=p_account and lease_id=p_lease and lease_until>now() for update;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>200 then
    raise exception 'Invalid orders page';
  end if;
  for r in select * from jsonb_to_recordset(p_rows) as x(order_id text,line_id text,sku text,asin text,product_title text,
     fulfillment text,purchased_at timestamptz,amount integer) loop
    if r.purchased_at is null or r.purchased_at < activation or r.purchased_at > now()
      or coalesce(r.order_id,'') !~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$' or length(coalesce(r.line_id,'')) not between 1 and 80
      or length(coalesce(r.sku,'')) not between 1 and 160 or coalesce(r.asin,'') !~ '^[A-Z0-9]{10}$'
      or coalesce(r.fulfillment,'') not in ('AMAZON','MERCHANT') then continue;end if;
    channel := (case r.fulfillment when 'AMAZON' then 'FBA' else '自己発送' end);
    label := (case p_account when 'amazon-1' then 'Amazon1' else 'Amazon2' end)||'（'||channel||'）';
    select i.* into item from app.items i
    where i.id=(select min(m.id::text)::uuid from app.items m where btrim(m.asin::text)=r.asin
      and (m.sales_channel::text=channel||right(p_account,1) or (p_account='amazon-1' and m.sales_channel::text=channel))
      and app.inventory_sku_matches(m.id,m.sku,r.sku) having count(*)=1);
    item_price := case when r.amount>0 then '｜'||to_char(r.amount,'FM999,999,990')||'円' end;
    if app.record_sale_notice(jsonb_build_array(p_account,r.order_id,r.line_id)::text,item.id,
      concat(label,'で売れました｜【',coalesce(app.product_serial(item.sku,item.lot_seq),left(r.sku,45)),'】',
        left(coalesce(item.title,r.product_title,''),100),item_price)) then queued:=queued+1;end if;
  end loop;
  return queued;
end $$;

revoke all on function app.record_sale_notice(text,uuid,text),app.observe_fleamarket_sale_notice(),
  app.claim_amazon_sale_poll(text),app.record_amazon_sale_page(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function app.claim_amazon_sale_poll(text),app.record_amazon_sale_page(text,uuid,jsonb) to service_role;

do $$
declare d text:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
begin
  if strpos(d,'coalesce(owner.display_name,owner.name),c.task_kind,')=0
     or strpos(d,'when ''packing_photo'' then')=0 then raise exception 'Unexpected management push function';end if;
  d:=replace(d,'case when e.kind in (''action'',''malfunction_message'')',
    'case when e.kind in (''action'',''malfunction_message'',''sale'')');
  d:=replace(d,'coalesce(owner.display_name,owner.name),c.task_kind,',
    'coalesce(owner.display_name,owner.name),case when e.kind = ''sale'' then sale.message else c.task_kind end,');
  d:=replace(d,'when ''packing_photo'' then','when ''sale'' then sale.id is not null when ''packing_photo'' then');
  d:=replace(d,'left join app.staff owner on owner.id=e.invoice_staff_id;',
    'left join app.staff owner on owner.id=e.invoice_staff_id left join app.sale_notices sale on sale.id=e.source_id and e.kind=''sale'';');
  execute d;
end $$;

select cron.schedule('amazon-sale-order-poll','*/5 * * * *',$job$
  with config as (
    select (select decrypted_secret from vault.decrypted_secrets where name='delivery_push_project_url') project_url,
      (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token') token
  )
  select net.http_post(
    url:=rtrim(project_url,'/')||'/functions/v1/amazon-sale-notices',
    headers:=jsonb_build_object('content-type','application/json','x-amazon-cron-token',token),
    body:='{}'::jsonb,timeout_milliseconds:=120000
  ) from config where project_url is not null and token is not null;
$job$);
notify pgrst,'reload schema';
