-- The publication stores the seller's chosen order, which may differ from
-- upload timestamps. Expose only authorized photo IDs, never old signed URLs.
create function app.line_listing_photo_order(p_item_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(ordered.id order by ordered.position),'[]'::jsonb) from (
  select p.id,min(photo.position) as position
  from app.seller_listings listing
  cross join lateral (
   select op.payload->'photos' as photos from app.seller_operations op
   where op.item_id=listing.item_id and op.kind='listing' and op.status='succeeded'
    and op.account_id=listing.account_id and op.channel=listing.channel
    and op.result->>'external_id'=listing.external_id
   order by op.created_at desc,op.id desc limit 1
  ) published
  cross join lateral jsonb_array_elements_text(case when jsonb_typeof(published.photos)='array' then published.photos else '[]'::jsonb end)
   with ordinality as photo(url,position)
  join app.items target on target.id=listing.item_id
  join app.items source on source.lot_seq=target.lot_seq and app.product_serial(source.sku,source.lot_seq)=app.product_serial(target.sku,target.lot_seq)
  join app.item_photos p on p.item_id=source.id and coalesce(p.photo_kind,'product')='product'
   and p.storage_path=substring(split_part(photo.url,'?',1) from '^https://[^/]+/storage/v1/object/(?:sign|public)/item-photos/(.+)$')
  where listing.item_id=p_item_id and listing.active
  group by p.id
 ) ordered;
$$;
revoke all on function app.line_listing_photo_order(uuid) from public,anon,authenticated;
grant execute on function app.line_listing_photo_order(uuid) to service_role;
do $$declare source text;patched text;begin
 source:=pg_get_functiondef('app.line_shipping_context(uuid)'::regprocedure);
 patched:=replace(source,$old$'overviewPhotoId',p.overview_photo_id,$old$,$new$'photoOrder',app.line_listing_photo_order(i.id),'overviewPhotoId',p.overview_photo_id,$new$);
 if patched=source then raise exception 'LINE shipping context changed';end if;
 execute patched;
end $$;
