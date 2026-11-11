-- The service account can apply a verified dispatch date through this
-- restricted function without gaining direct write access to inventory.
create function app.apply_amazon_self_dispatch(
  p_item uuid, p_account text, p_sku text, p_asin text,
  p_status app.item_status, p_updated_at timestamptz, p_shipped_on date
)
returns boolean language plpgsql security definer
set search_path = ''
as $$
begin
  if p_account is null or p_account not in ('amazon-1', 'amazon-2')
    or p_shipped_on is null or p_shipped_on > (now() at time zone 'Asia/Tokyo')::date
    or nullif(p_sku, '') is null or coalesce(p_asin, '') !~ '^[A-Z0-9]{10}$' then
    return false;
  end if;

  update app.items i set shipped_on = p_shipped_on
  where i.id = p_item and i.sku = p_sku and i.asin = p_asin
    and i.updated_at = p_updated_at and i.status = p_status
    and i.status in ('出品中', '取引中', '販売済')
    and i.shipped_on is null and i.purchased_at <= p_shipped_on
    and (
      (p_account = 'amazon-1' and i.sales_channel in ('自己発送', '自己発送1'))
      or (p_account = 'amazon-2' and i.sales_channel = '自己発送2')
    );
  return found;
end;
$$;
revoke all on function app.apply_amazon_self_dispatch(uuid,text,text,text,app.item_status,timestamptz,date)
  from public, anon, authenticated;
grant execute on function app.apply_amazon_self_dispatch(uuid,text,text,text,app.item_status,timestamptz,date)
  to service_role;
notify pgrst, 'reload schema';
