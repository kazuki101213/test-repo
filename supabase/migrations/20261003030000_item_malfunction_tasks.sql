alter table app.items
  add column if not exists malfunction_reported boolean not null default false,
  add column if not exists malfunction_comment text,
  add column if not exists malfunction_reported_at timestamptz,
  add column if not exists malfunction_reported_by uuid references app.staff(id) on delete set null,
  add column if not exists malfunction_resolved_at timestamptz,
  add column if not exists malfunction_resolved_by uuid references app.staff(id) on delete set null;

alter table app.items drop constraint if exists items_malfunction_comment_check;
alter table app.items add constraint items_malfunction_comment_check check (
  malfunction_comment is null or length(malfunction_comment)<=2000
);
create index if not exists items_malfunction_tasks_idx
  on app.items(malfunction_reported_at desc) where malfunction_reported and malfunction_resolved_at is null;

create or replace function app.report_item_malfunction(p_item_id uuid,p_comment text)
returns void language plpgsql security definer set search_path='' as $$
declare staff_id uuid:=app.current_staff_id();
begin
 if auth.uid() is null or staff_id is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if length(btrim(coalesce(p_comment,'')))=0 or length(p_comment)>2000 then raise exception '動作不良の内容を2000文字以内で入力してください' using errcode='22023'; end if;
 perform app.assert_can_work_on(p_item_id);
 update app.items set malfunction_reported=true,malfunction_comment=btrim(p_comment),
   malfunction_reported_at=clock_timestamp(),malfunction_reported_by=staff_id,
   malfunction_resolved_at=null,malfunction_resolved_by=null
 where id=p_item_id;
 if not found then raise exception '商品が見つかりません' using errcode='P0002'; end if;
end $$;
revoke all on function app.report_item_malfunction(uuid,text) from public,anon,authenticated;
grant execute on function app.report_item_malfunction(uuid,text) to authenticated;

create or replace function app.resolve_item_malfunction(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() then raise exception '管理者権限が必要です' using errcode='42501'; end if;
 update app.items set malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=app.current_staff_id()
 where id=p_item_id and malfunction_reported and malfunction_resolved_at is null;
 if not found then raise exception '未対応の動作不良タスクが見つかりません' using errcode='P0002'; end if;
end $$;
revoke all on function app.resolve_item_malfunction(uuid) from public,anon,authenticated;
grant execute on function app.resolve_item_malfunction(uuid) to authenticated;

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
  case when i.marketplace::text='動作品Amazon返品' then i.title else p.model_no end as model_no,
  i.malfunction_reported,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_resolved_at
from app.items i
left join app.products p on p.id=i.product_id
left join app.staff buyer on buyer.id=i.purchaser_id
where i.status in ('仕入済','入荷済','作業中','Amazon返品','出荷済','出品中','販売済');
grant select on app.v_delivery_tasks to authenticated;

notify pgrst,'reload schema';
