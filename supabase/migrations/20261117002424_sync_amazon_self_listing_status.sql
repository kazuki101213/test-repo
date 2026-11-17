create function app.apply_observed_amazon_self_listing(p_request_id uuid, p_expected_sku text)
returns boolean language plpgsql security definer set search_path = pg_catalog, app as $$
declare
  receipt app.amazon_listing_submissions;
  item app.items;
  actor_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception '内部処理専用です' using errcode = '42501';
  end if;
  select * into receipt from app.amazon_listing_submissions where request_id = p_request_id for update;
  if not found or receipt.state not in ('accepted', 'uncertain', 'submitting', 'verified')
     or receipt.sales_channel::text not in ('自己発送', '自己発送1', '自己発送2') then
    return false;
  end if;

  select * into item from app.items where id = receipt.item_id for update;
  if not found or item.status <> '商品登録前' or item.sku is distinct from p_expected_sku
     or item.sold_on is not null or item.returned_on is not null or item.packed_on is null
     or (item.malfunction_reported and item.malfunction_resolved_at is null)
     or (item.is_accessory and not app.is_standalone_accessory_serial(item.sku, item.lot_seq))
     or btrim(item.asin::text) is distinct from receipt.asin
     or item.condition::text is distinct from receipt.item_condition
     or item.sales_channel is distinct from receipt.sales_channel
     or receipt.account_id is distinct from (case when item.sales_channel::text = '自己発送2' then 'amazon-2' else 'amazon-1' end)
     or receipt.seller_id is distinct from (case when item.sales_channel::text = '自己発送2' then 'A3E7BXJWH9TP11' else 'A1WI3OGPE43N2T' end)
     or not app.inventory_sku_matches(item.id, item.sku, receipt.sku)
     or not app.listing_photos_approved(item.id) then
    return false;
  end if;

  select staff.id into actor_id
  from app.staff staff join app.profiles profile on profile.staff_id = staff.id
  where profile.user_id = receipt.requested_by and staff.is_active
    and (staff.role = 'admin' or staff.id = item.deliverer_id);
  if not found then return false; end if;

  update app.items set status = '出品中', product_registered_at = coalesce(product_registered_at, clock_timestamp())
  where id = item.id;
  insert into app.inventory_workflow_events(id, item_id, actor_id, action, from_status, to_status, note)
  values (gen_random_uuid(), item.id, actor_id, 'amazon_listing_status_sync', item.status, '出品中', 'Amazon購入可能SKU: ' || receipt.sku);
  return true;
end $$;
revoke all on function app.apply_observed_amazon_self_listing(uuid, text) from public, anon, authenticated;
grant execute on function app.apply_observed_amazon_self_listing(uuid, text) to service_role;

select cron.schedule('amazon-self-listing-status-refresh', '0 16 * * *', $job$
  with targets as (
    select distinct on (item.id) receipt.request_id
    from app.amazon_listing_submissions receipt
    join app.items item on item.id = receipt.item_id
    where item.status = '商品登録前' and item.sold_on is null and item.packed_on is not null
      and receipt.sales_channel::text in ('自己発送', '自己発送1', '自己発送2')
      and receipt.sales_channel = item.sales_channel
      and receipt.state in ('accepted', 'uncertain', 'submitting', 'verified')
    order by item.id, receipt.created_at desc, receipt.request_id
  ), config as (
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'delivery_push_project_url') project_url,
      (select decrypted_secret from vault.decrypted_secrets where name = 'amazon_daily_sync_token') token
  )
  select net.http_post(
    url := rtrim(config.project_url, '/') || '/functions/v1/amazon-listing-submit',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-amazon-cron-token', config.token),
    body := jsonb_build_object('action', 'sync-status', 'requestId', targets.request_id),
    timeout_milliseconds := 45000
  )
  from targets cross join config
  where config.project_url is not null and config.token is not null;
$job$);

notify pgrst, 'reload schema';
