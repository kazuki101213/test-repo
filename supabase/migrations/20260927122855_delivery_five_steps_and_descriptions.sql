alter table app.items add column if not exists cleaned_at timestamptz;
alter table app.items add column if not exists description_template text;
alter table app.items add column if not exists manufacture_year integer;
alter table app.items add constraint items_description_template_check check (description_template is null or description_template in ('小物','ブルーレイレコーダー','モニター','テレビ'));
alter table app.items add constraint items_manufacture_year_check check (manufacture_year is null or manufacture_year between 1900 and 2100);
-- Previously inspection and cleaning were one completed step.
update app.items set cleaned_at = inspected_at where cleaned_at is null and inspected_at is not null;
CREATE OR REPLACE FUNCTION app.items_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- 手動で設定された終端ステータスは尊重する
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then
    return new;
  end if;

  -- Amazon から戻ってきた個体は、再出荷するまで「Amazon返品」のまま。
  -- 既に作業済みの個体が返ってくるので、過去の作業チェックは消さずに残す。
  -- 返品日が分からない行（移行元に日付が無かったもの）でも印だけは保てるよう、
  -- 日付と status のどちらかが立っていれば返品扱いにする。
  if new.amazon_returned_on is not null or new.status = 'Amazon返品' then
    if new.shipped_on is not null
       and (new.amazon_returned_on is null or new.shipped_on > new.amazon_returned_on) then
      null;   -- 返品後に出荷し直したので、通常の進捗に戻す
    else
      new.status := 'Amazon返品';
      return new;
    end if;
  end if;

  new.status := case
    when new.shipped_on is not null then '出荷済'
    when new.product_registered_at is not null
      or new.inspected_at is not null
      or new.cleaned_at is not null
      or new.photo_uploaded_at is not null
      or new.packed_on is not null then '作業中'
    when new.arrived_on is not null then '入荷済'
    else '仕入済'
  end;

  -- 出荷済みかつ出品日が入っていれば出品中
  if new.listed_on is not null and new.status = '出荷済' then
    new.status := '出品中';
  end if;

  return new;
end;
$function$
;
drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status before insert or update of arrived_on, product_registered_at, inspected_at, cleaned_at, photo_uploaded_at, packed_on, shipped_on, listed_on, amazon_returned_on on app.items for each row execute function app.items_sync_status();

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
    shipped_on = case when p_step = 'shipped' then case when p_done then coalesce(shipped_on,current_date) else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end;
$$;
revoke all on function app.set_work_progress(uuid,text,boolean) from public, anon;
grant execute on function app.set_work_progress(uuid,text,boolean) to authenticated;

create or replace function app.save_delivery_description(p_item_id uuid, p_condition app.item_condition, p_accessories text, p_description text, p_template text, p_manufacture_year integer)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  perform app.assert_can_work_on(p_item_id);
  if p_template is not null and p_template not in ('小物','ブルーレイレコーダー','モニター','テレビ') then
    raise exception '商品種別を確認してください' using errcode='22023';
  end if;
  if char_length(p_description)>10000 or char_length(p_accessories)>2000 then
    raise exception '入力文字数が上限を超えています' using errcode='22023';
  end if;
  update app.items set condition=p_condition, accessories=p_accessories, description=p_description,
    description_template=p_template, manufacture_year=p_manufacture_year where id=p_item_id;
end;
$$;
revoke all on function app.save_delivery_description(uuid,app.item_condition,text,text,text,integer) from public, anon;
grant execute on function app.save_delivery_description(uuid,app.item_condition,text,text,text,integer) to authenticated;

create or replace view app.v_delivery_tasks with (security_invoker=true) as
SELECT i.id,
    i.sku,
    i.lot_seq,
    i.is_accessory,
    i.status,
    i.work_stream,
    i.title,
    i.asin,
    i.condition,
    i.purchased_at,
    i.marketplace,
    i.tracking_no,
    i.accessories,
    i.description,
    i.sales_channel,
    i.planned_price,
    i.deliverer_id,
    buyer.name AS purchaser_name,
    i.arrived_on,
    i.product_registered_at IS NOT NULL AS product_registered,
    i.inspected_at IS NOT NULL AS inspected,
    i.photo_uploaded_at IS NOT NULL AS photo_uploaded,
    i.packed_on,
    i.shipped_on,
    i.amazon_returned_on,
    p.image_url AS reference_image_url,
    ( SELECT count(*) AS count
           FROM app.item_photos ph
          WHERE ph.item_id = i.id) AS photo_count,
    ( SELECT max(cm.created_at) AS max
           FROM app.item_comments cm
          WHERE cm.item_id = i.id) AS last_comment_at,
    (i.cleaned_at is not null) as cleaned,
    i.description_template,
    i.manufacture_year
   FROM app.items i
     LEFT JOIN app.products p ON p.id = i.product_id
     LEFT JOIN app.staff buyer ON buyer.id = i.purchaser_id
  WHERE i.status = ANY (ARRAY['仕入済'::app.item_status, '入荷済'::app.item_status, '作業中'::app.item_status, 'Amazon返品'::app.item_status, '出荷済'::app.item_status, '出品中'::app.item_status, '販売済'::app.item_status]);
notify pgrst, 'reload schema';
