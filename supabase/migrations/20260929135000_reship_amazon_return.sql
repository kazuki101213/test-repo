-- A completed shipping step after an Amazon return must record a new date.
-- Keeping the old date leaves the item permanently marked as returned.
create or replace function app.set_work_progress(p_item_id uuid, p_step text, p_done boolean default true)
returns app.items language plpgsql security definer set search_path = app, public as $$
declare v_item app.items;
begin
  if p_step is null or p_done is null or p_step not in ('arrived','registered','inspected','cleaned','photo','listing','packed','shipped') then
    raise exception '不明な作業ステップです' using errcode = '22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  update app.items set
    arrived_on = case when p_step = 'arrived' then case when p_done then coalesce(arrived_on,current_date) else null end
      when p_done then coalesce(arrived_on,current_date) else arrived_on end,
    product_registered_at = case when p_step in ('registered','listing') then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
    inspected_at = case when p_step = 'inspected' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
    cleaned_at = case when p_step = 'cleaned' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
    photo_uploaded_at = case when p_step in ('photo','listing') then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
    packed_on = case when p_step = 'packed' then case when p_done then coalesce(packed_on,current_date) else null end else packed_on end,
    shipped_on = case when p_step = 'shipped' then case when p_done then
      case when (amazon_returned_on is not null and shipped_on <= amazon_returned_on)
             or (amazon_returned_on is null and status = 'Amazon返品')
        then current_date else coalesce(shipped_on,current_date) end
      else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end;
$$;
