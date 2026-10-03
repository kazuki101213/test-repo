alter type app.marketplace add value if not exists '動作品Amazon返品';

update storage.buckets
set allowed_mime_types = array(
  select distinct t.mime
  from unnest(coalesce(allowed_mime_types, '{}'::text[]) || array['application/pdf','image/jpeg']::text[]) as t(mime)
)
where id='invoice-receipts';

alter table app.invoice_receipts
  add column if not exists document_type text not null default 'receipt_photo',
  add column if not exists mime_type text not null default 'image/jpeg';
alter table app.invoice_receipts drop constraint if exists invoice_receipts_check;
alter table app.invoice_receipts drop constraint if exists invoice_receipts_document_type_check;
alter table app.invoice_receipts drop constraint if exists invoice_receipts_mime_type_check;
alter table app.invoice_receipts add constraint invoice_receipts_check check (
  storage_path ~ ('^'||staff_id::text||'/'||to_char(billing_month,'YYYY-MM')||'/[0-9a-f-]{36}\.(jpg|pdf)$')
);
alter table app.invoice_receipts add constraint invoice_receipts_document_type_check
  check (document_type in ('invoice','receipt','receipt_photo'));
alter table app.invoice_receipts add constraint invoice_receipts_mime_type_check
  check ((storage_path like '%.pdf' and mime_type='application/pdf') or (storage_path like '%.jpg' and mime_type='image/jpeg'));
grant insert(document_type,mime_type) on app.invoice_receipts to authenticated;

create or replace function app.fill_receipt_submission() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',id,'storage_path',storage_path,'original_name',original_name,
   'document_type',document_type,'mime_type',mime_type
 ) order by created_at,id),'[]'::jsonb)
 into new.files from app.invoice_receipts
 where staff_id=new.staff_id and billing_month=new.billing_month and document_type in ('receipt','receipt_photo');
 if jsonb_array_length(new.files)=0 then raise exception '領収書または領収書の写真を追加してください'; end if;
 new.submitted_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;

create or replace function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date; photo_exempt boolean;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 select marketplace::text='動作品Amazon返品' into photo_exempt from app.items where id=p_item_id;
 if p_done and p_step in ('packed','shipped') and not coalesce(photo_exempt,false)
   and app.photo_review_enforced() and not app.is_delivery_master()
   and not exists (select 1 from app.photo_reviews r where r.item_id=p_item_id and r.approved_at is not null) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' and not coalesce(photo_exempt,false) then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;
revoke all on function app.set_delivery_progress(uuid,text,boolean,date) from public,anon,authenticated;
grant execute on function app.set_delivery_progress(uuid,text,boolean,date) to authenticated;

create or replace function app.require_photo_review(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if app.photo_review_enforced() and not app.is_delivery_master()
     and not exists(select 1 from app.items where id=p_item_id and marketplace::text='動作品Amazon返品')
     and not exists (select 1 from app.photo_reviews where item_id=p_item_id and approved_at is not null) then
    raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
  end if;
end $$;
revoke all on function app.require_photo_review(uuid) from public,anon,authenticated;

create or replace view app.v_delivery_tasks with (security_invoker = true) as
select
  i.id,i.sku,i.lot_seq,i.is_accessory,i.status,i.work_stream,i.title,
  i.asin,i.condition,i.purchased_at,i.marketplace,i.tracking_no,i.accessories,i.description,
  i.sales_channel,i.planned_price,i.deliverer_id,buyer.name as purchaser_name,i.arrived_on,
  (i.product_registered_at is not null) as product_registered,
  (i.inspected_at is not null) as inspected,(i.photo_uploaded_at is not null) as photo_uploaded,
  i.packed_on,i.shipped_on,i.amazon_returned_on,p.image_url as reference_image_url,
  (select count(*) from app.item_photos ph where ph.item_id=i.id) as photo_count,
  (select max(cm.created_at) from app.item_comments cm where cm.item_id=i.id) as last_comment_at,
  (i.cleaned_at is not null) as cleaned,i.description_template,i.manufacture_year,
  i.marketplace_item_id,
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no
from app.items i
left join app.products p on p.id=i.product_id
left join app.staff buyer on buyer.id=i.purchaser_id
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;

create or replace function app.monthly_gross_profit_by_purchaser(p_purchaser_id uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare current_id uuid:=app.current_staff_id(); current_user_role text:=app.current_role(); result jsonb;
begin
 if auth.uid() is null or current_id is null or p_month is null or extract(day from p_month)<>1 then
  raise exception '対象月またはログイン情報が不正です' using errcode='22023';
 end if;
 if current_user_role='admin' then
  if p_purchaser_id is null or not exists(select 1 from app.staff where id=p_purchaser_id and is_active and role in ('admin','purchaser')) then
   raise exception '仕入担当者を選択してください' using errcode='22023';
  end if;
 elsif current_user_role='purchaser' then
  if p_purchaser_id is distinct from current_id then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 elsif current_user_role='deliverer' then
  if p_purchaser_id is not null then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 else raise exception '閲覧する権限がありません' using errcode='42501'; end if;

 with candidates as (
  select app.product_serial(i.sku,i.lot_seq) as serial_key,i.sku,
    d.product_sold_on as sold_on,owner.name as purchaser_name,
    d.product_profit as gross_profit,i.created_at
  from app.items i
  join app.v_inventory_display d on d.id=i.id
  left join app.staff owner on owner.id=i.purchaser_id
  where not i.is_accessory and not d.product_sale_conflict
    and d.product_sold_on>=p_month and d.product_sold_on<p_month+interval '1 month'
    and d.product_profit is not null
    and ((current_user_role='admin' and i.purchaser_id=p_purchaser_id)
      or (current_user_role='purchaser' and i.purchaser_id=current_id)
      or (current_user_role='deliverer' and i.deliverer_id=current_id))
 ), products as (
  select distinct on(serial_key) serial_key,sku,sold_on,purchaser_name,gross_profit
  from candidates order by serial_key,created_at,sku
 )
 select jsonb_build_object(
  'rows',coalesce(jsonb_agg(jsonb_build_object('sku',sku,'sold_on',sold_on,'purchaser_name',purchaser_name,'gross_profit',gross_profit) order by sold_on,sku),'[]'::jsonb),
  'total',coalesce(sum(gross_profit),0)
 ) into result from products;
 return result;
end $$;
revoke all on function app.monthly_gross_profit_by_purchaser(uuid,date) from public,anon,authenticated;
grant execute on function app.monthly_gross_profit_by_purchaser(uuid,date) to authenticated;

create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint; monthly_profit bigint:=0;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then raise exception '請求書へのアクセス権がありません' using errcode='42501'; end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 with bodies as (
  select distinct on(app.product_serial(sku,lot_seq)) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,sku
  from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
  order by app.product_serial(sku,lot_seq),packed_on,id
 ), selected as (select * from bodies where packed_on>=p_month and packed_on<p_month+interval '1 month')
 select coalesce(jsonb_agg(jsonb_build_object('item_id',id,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
   'description',case when marketplace::text='動作品Amazon返品' then '動作品Amazon返品対応'
     when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
     when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
   'title',title,'quantity',1,
   'unit_price',case when marketplace::text='動作品Amazon返品' then floor(p.unit_price/2.0)::integer else p.unit_price end,
   'amount',case when marketplace::text='動作品Amazon返品' then floor(p.unit_price/2.0)::integer else p.unit_price end
  ) order by packed_on,lot_seq),'[]'::jsonb),coalesce(sum(case when marketplace::text='動作品Amazon返品' then floor(p.unit_price/2.0)::integer else p.unit_price end),0)
 into lines,subtotal from selected;
 if p.details->>'issuer_name'='石川秀樹' then
  monthly_profit:=coalesce((app.monthly_gross_profit_by_purchaser(p_staff,p_month)->>'total')::bigint,0);
 end if;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent,
  'purchaser_gross_profit',monthly_profit);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

create or replace function app.fill_delivery_invoice()
returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare doc jsonb; line jsonb; normalized jsonb:='[]'; qty integer; price bigint; sub bigint; tax bigint; date_value date;
  is_ishikawa boolean; workday_count integer:=0; gross bigint:=0; percent_amount bigint:=0; base_amount bigint:=0;
begin
 if jsonb_typeof(new.extras)<>'array' or jsonb_array_length(new.extras)>100 then raise exception '追加明細は100行以内で入力してください'; end if;
 doc:=app.prepare_delivery_invoice(new.staff_id,new.billing_month);
 sub:=(doc->>'subtotal')::bigint;
 is_ishikawa:=doc->'profile'->>'issuer_name'='石川秀樹';
 gross:=coalesce((doc->>'purchaser_gross_profit')::bigint,0);
 for line in select value from jsonb_array_elements(new.extras) loop
  if jsonb_typeof(line)<>'object' or length(trim(coalesce(line->>'description','')))=0 or length(line->>'description')>200
  or coalesce(line->>'quantity','') !~ '^[0-9]+$' or coalesce(line->>'unit_price','') !~ '^[0-9]+$' then
   raise exception '追加明細の内容・数量・単価を確認してください';
  end if;
  if line->>'description'='粗利益連動調整' then continue; end if;
  qty:=(line->>'quantity')::integer; price:=(line->>'unit_price')::bigint;
  date_value:=nullif(line->>'date','')::date;
  if line->>'description'='ヤフオク入札作業日' then
   if not is_ishikawa or qty<>1 or price<>4500 or date_value is null
    or date_value<new.billing_month or date_value>=new.billing_month+interval '1 month' then
    raise exception 'ヤフオク入札作業日は石川秀樹の対象月内の日付で登録してください';
   end if;
   if exists(select 1 from jsonb_array_elements(normalized) x where x->>'description'='ヤフオク入札作業日' and x->>'date'=date_value::text) then
    raise exception '同じ作業日が重複しています';
   end if;
   normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description','ヤフオク入札作業日','quantity',1,'unit_price',4500,'amount',4500));
   workday_count:=workday_count+1; sub:=sub+4500;
   continue;
  end if;
  if qty<1 or qty>100000 or price<0 or price>10000000 then raise exception '追加明細の金額が範囲外です'; end if;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description',trim(line->>'description'),'quantity',qty,'unit_price',price,'amount',qty*price));
  sub:=sub+qty*price;
 end loop;
 if is_ishikawa then
  base_amount:=workday_count*4500;
  percent_amount:=floor(greatest(gross,0)*0.10)::bigint;
  if percent_amount>base_amount then
   normalized:=normalized||jsonb_build_array(jsonb_build_object('date',null,'description','粗利益連動調整','quantity',1,'unit_price',percent_amount-base_amount,'amount',percent_amount-base_amount));
   sub:=sub+(percent_amount-base_amount);
  end if;
 end if;
 tax:=floor(sub*(doc->>'tax_percent')::numeric/100);
 new.extras:=normalized;
 new.snapshot:=doc||jsonb_build_object('extras',normalized,'subtotal',sub,'tax',tax);
 new.total:=sub+tax;
 new.updated_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_delivery_invoice() from public,anon,authenticated;

notify pgrst,'reload schema';
