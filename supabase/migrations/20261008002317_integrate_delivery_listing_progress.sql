-- Shared handler for the displayed 商品登録・写真登録 step.
-- p_done NULL records a successful photo upload without completing product registration.
create function app.set_delivery_listing_progress(p_item_id uuid,p_done boolean default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 perform app.assert_can_work_on(p_item_id);
 if p_done is null and not exists(select 1 from app.item_photos where item_id=p_item_id) then
   raise exception 'アップロード済みの写真がありません' using errcode='22023';
 end if;
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 update app.items set
   product_registered_at=case when p_done is null then product_registered_at
     when p_done then coalesce(product_registered_at,now()) else null end,
   photo_uploaded_at=case when p_done is null then coalesce(photo_uploaded_at,now())
     when photo_exempt then photo_uploaded_at
     when p_done then coalesce(photo_uploaded_at,now()) else null end
 where id=p_item_id returning * into result;
 return result;
end $$;
revoke all on function app.set_delivery_listing_progress(uuid,boolean) from public,anon;
grant execute on function app.set_delivery_listing_progress(uuid,boolean) to authenticated;
CREATE OR REPLACE FUNCTION app.set_delivery_progress(p_item_id uuid, p_step text, p_done boolean, p_on date DEFAULT NULL::date)
 RETURNS app.items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result app.items; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 if p_step='listing' then return app.set_delivery_listing_progress(p_item_id,p_done);end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false)
   and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $function$
;
create or replace function app.set_work_progress(p_item_id uuid,p_step text,p_done boolean default true)
returns app.items language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_step<>'photo' or p_done is distinct from true then
   raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 return app.set_delivery_listing_progress(p_item_id,null);
end $$;
