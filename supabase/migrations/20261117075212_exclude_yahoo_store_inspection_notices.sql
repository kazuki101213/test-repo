-- A Yahoo! Auctions store purchase does not require the buyer's receipt confirmation.
create table workload_private.yahoo_auction_seller_types (
  auction_id text primary key check (auction_id ~ '^[a-z][0-9]{1,18}$'),
  is_store boolean,
  request_id bigint,
  checked_at timestamptz not null default now()
);
alter table workload_private.yahoo_auction_seller_types enable row level security;
revoke all on workload_private.yahoo_auction_seller_types from public, anon, authenticated;
grant select on workload_private.yahoo_auction_seller_types to authenticated;
create policy yahoo_auction_seller_types_admin_read
  on workload_private.yahoo_auction_seller_types for select to authenticated
  using ((select auth.uid()) is not null and (select app.is_admin()));

insert into workload_private.yahoo_auction_seller_types (auction_id, is_store, checked_at)
select lower(r.marketplace_item_id), true, max(r.updated_at)
from app.marketplace_extension_receipts r
where r.marketplace = 'ヤフオク' and r.state = 'succeeded'
  and r.details like 'ストア購入: 受取連絡不要;%'
  and lower(r.marketplace_item_id) ~ '^[a-z][0-9]{1,18}$'
group by lower(r.marketplace_item_id);

-- Read the exact item's seller from Yahoo's page data. Missing or mismatched pages are unknown.
create function workload_private.yahoo_auction_page_is_store(p_html text, p_auction_id text)
returns boolean
language plpgsql immutable strict
set search_path = ''
as $function$
declare
  page_data text := substring(p_html from '<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>');
  item jsonb;
begin
  if page_data is null or not pg_input_is_valid(page_data, 'jsonb') then
    return null;
  end if;
  item := page_data::jsonb #> '{props,pageProps,initialState,item,detail,item}';
  if lower(item->>'auctionId') is distinct from p_auction_id
    or jsonb_typeof(item #> '{seller,isStore}') is distinct from 'boolean' then
    return null;
  end if;
  return (item #>> '{seller,isStore}')::boolean;
end
$function$;
revoke all on function workload_private.yahoo_auction_page_is_store(text,text)
  from public, anon, authenticated;

create function workload_private.refresh_yahoo_auction_seller_types()
returns void
language plpgsql
set search_path = ''
as $function$
declare
  candidate record;
begin
  if not pg_try_advisory_xact_lock(hashtext('manage-yahoo-auction-seller-types')) then
    return;
  end if;

  update workload_private.yahoo_auction_seller_types s
  set is_store = case when r.status_code = 200 and not coalesce(r.timed_out, false)
      then workload_private.yahoo_auction_page_is_store(r.content, s.auction_id) end,
      request_id = null,
      checked_at = now()
  from net._http_response r
  where s.request_id = r.id;

  -- The networking queue is unlogged. Clear a lost request so it can be retried.
  update workload_private.yahoo_auction_seller_types
  set request_id = null, checked_at = now()
  where request_id is not null and checked_at < now() - interval '4 hours';

  for candidate in
    select lower(i.marketplace_item_id) as auction_id
    from app.item_tracking_recordings t
    join app.items i on i.id = t.item_id
    left join workload_private.yahoo_auction_seller_types s
      on s.auction_id = lower(i.marketplace_item_id)
    where i.marketplace = 'ヤフオク'
      and i.deliverer_id is not null and i.sold_on is null
      and i.inspected_at is null and i.malfunction_reported_at is null
      and nullif(btrim(i.tracking_no), '') is not null
      and (i.status in ('受取前','検品中') or (
        i.status = '商品登録前' and i.is_accessory
        and not app.is_standalone_accessory_serial(i.sku, i.lot_seq)
      ))
      and t.recorded_at <= now() - interval '1 day'
      and lower(i.marketplace_item_id) ~ '^[a-z][0-9]{1,18}$'
      and (s.auction_id is null or (
        s.is_store is null and s.request_id is null
        and s.checked_at < now() - interval '1 day'
      ))
    group by lower(i.marketplace_item_id)
    order by min(t.recorded_at), lower(i.marketplace_item_id)
    limit 24
  loop
    insert into workload_private.yahoo_auction_seller_types (auction_id, request_id)
    values (
      candidate.auction_id,
      net.http_get(
        url := 'https://auctions.yahoo.co.jp/jp/auction/' || candidate.auction_id,
        headers := '{"Accept-Language":"ja,en;q=0.8"}'::jsonb,
        timeout_milliseconds := 10000
      )
    )
    on conflict (auction_id) do update set
      request_id = excluded.request_id, checked_at = excluded.checked_at
    where workload_private.yahoo_auction_seller_types.is_store is null;
  end loop;
end
$function$;
revoke all on function workload_private.refresh_yahoo_auction_seller_types()
  from public, anon, authenticated;

do $migration$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  updated text;
begin
  updated := replace(definition,
    $old$where t.kind='inspection'$old$,
    $new$where t.kind='inspection'
      and not (i.marketplace = 'ヤフオク' and (
        coalesce(i.marketplace_url, '') ~* '^https://buy\.auctions\.yahoo\.co\.jp/order/status([/?#]|$)'
        or exists (
          select 1 from workload_private.yahoo_auction_seller_types seller
          where seller.auction_id = lower(i.marketplace_item_id) and seller.is_store is true
        )
      ))$new$);
  if updated = definition then
    raise exception 'Admin inspection snapshot source not found';
  end if;
  execute updated;
end $migration$;

select cron.schedule(
  'yahoo-auction-seller-type-for-inspection',
  '11 * * * *',
  $job$select workload_private.refresh_yahoo_auction_seller_types();$job$
);
notify pgrst, 'reload schema';
