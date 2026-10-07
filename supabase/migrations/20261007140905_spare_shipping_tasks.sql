-- Explicit source/target links preserve the accessory identity throughout shipping.
create table app.spare_shipping_tasks (
  id uuid primary key default gen_random_uuid(),
  spare_id uuid not null unique references app.spare_accessories(id),
  item_id uuid not null references app.items(id) on delete cascade,
  accessory_item_id uuid not null unique references app.items(id) on delete cascade,
  owner_staff_id uuid not null references app.staff(id),
  recipient_staff_id uuid not null references app.staff(id),
  title text not null, manufacturer text, marketplace text, marketplace_item_id text, usage_note text,
  lot_seq integer not null,
  tracking_no text,
  created_at timestamptz not null default now(),
  sent_at timestamptz, completed_at timestamptz,
  check(owner_staff_id<>recipient_staff_id),
  check((sent_at is null and tracking_no is null) or (sent_at is not null and nullif(btrim(tracking_no),'') is not null)),
  check(completed_at is null or sent_at is not null)
);
create index spare_shipping_owner_pending_idx on app.spare_shipping_tasks(owner_staff_id,created_at)
  where sent_at is null and completed_at is null;
alter table app.spare_shipping_tasks enable row level security;
revoke all on app.spare_shipping_tasks from public,anon,authenticated;
grant select on app.spare_shipping_tasks to authenticated;
grant all on app.spare_shipping_tasks to service_role;
create policy spare_shipping_read on app.spare_shipping_tasks for select to authenticated
using (app.current_role() is not null and (app.is_admin() or owner_staff_id=app.current_staff_id()));

create view app.v_spare_shipping_tasks with (security_invoker=true) as
select t.*,o.code owner_code,o.name owner_name,d.code recipient_code,d.name recipient_name
from app.spare_shipping_tasks t join app.staff o on o.id=t.owner_staff_id
join app.staff d on d.id=t.recipient_staff_id;
revoke all on app.v_spare_shipping_tasks from public,anon,authenticated;
grant select on app.v_spare_shipping_tasks to authenticated;

-- Definer is needed only to enqueue for another holder; validate the existing allocation first.
create function app.queue_spare_shipping(p_spare_id uuid,p_item_id uuid,p_accessory_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s app.spare_accessories; i app.items; a app.items; task_id uuid;
begin
  if auth.uid() is null or app.current_role() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '発送依頼を作成する権限がありません' using errcode='42501';
  end if;
  select * into s from app.spare_accessories where id=p_spare_id for update;
  select * into i from app.items where id=p_item_id;
  select * into a from app.items where id=p_accessory_id;
  if s.id is null or i.id is null or a.id is null or s.used_for_item_id is distinct from i.id
    or not a.is_accessory or a.lot_seq is distinct from i.lot_seq
    or a.deliverer_id is distinct from i.deliverer_id
    or a.title is distinct from s.title or a.marketplace_item_id is distinct from s.marketplace_item_id
    or a.purchaser_id is distinct from coalesce(s.owner_staff_id,i.purchaser_id)
    or (not app.is_admin() and (s.owner_staff_id is distinct from app.current_staff_id()
      or i.purchaser_id is distinct from app.current_staff_id())) then
    raise exception '予備と付属品の紐づけを確認できません' using errcode='22023';
  end if;
  if s.owner_staff_id is null or i.deliverer_id is null or s.owner_staff_id=i.deliverer_id then return null; end if;
  if not exists(select 1 from app.staff where id=s.owner_staff_id and is_active)
    or not exists(select 1 from app.staff where id=i.deliverer_id and is_active) then
    raise exception '発送元または発送先の担当者が無効です' using errcode='22023';
  end if;
  insert into app.spare_shipping_tasks(spare_id,item_id,accessory_item_id,owner_staff_id,recipient_staff_id,
    title,manufacturer,marketplace,marketplace_item_id,usage_note,lot_seq)
  values(s.id,i.id,a.id,s.owner_staff_id,i.deliverer_id,s.title,s.manufacturer,s.marketplace,
    s.marketplace_item_id,s.usage_note,i.lot_seq)
  on conflict(spare_id) do nothing returning id into task_id;
  if task_id is null then
    select id into task_id from app.spare_shipping_tasks where spare_id=s.id
      and item_id=i.id and accessory_item_id=a.id;
    if task_id is null then raise exception '既存の発送依頼と紐づけが異なります' using errcode='22023'; end if;
  end if;
  return task_id;
end $$;
revoke all on function app.queue_spare_shipping(uuid,uuid,uuid) from public,anon;
grant execute on function app.queue_spare_shipping(uuid,uuid,uuid) to authenticated;

-- The holder may update only the exact linked accessory's tracking number.
create function app.send_spare_shipping(p_task_id uuid,p_tracking_no text)
returns void language plpgsql security definer set search_path='' as $$
declare t app.spare_shipping_tasks; tracking text:=nullif(btrim(p_tracking_no),'');
begin
  if auth.uid() is null or app.current_role() is null then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  select * into t from app.spare_shipping_tasks where id=p_task_id for update;
  if t.id is null or t.owner_staff_id is distinct from app.current_staff_id() then
    raise exception '自分の発送依頼のみ送信できます' using errcode='42501';
  end if;
  if tracking is null or length(tracking)>200 then
    raise exception '追跡番号を1〜200文字で入力してください' using errcode='22023';
  end if;
  if t.sent_at is not null then
    if t.tracking_no=tracking then return; end if;
    raise exception 'この発送依頼は送信済みです' using errcode='22023';
  end if;
  if not exists(select 1 from app.items where id=t.item_id and deliverer_id=t.recipient_staff_id)
    or not exists(select 1 from app.spare_accessories where id=t.spare_id and used_for_item_id=t.item_id
      and owner_staff_id=t.owner_staff_id) then
    raise exception '担当者または予備の割当が変更されています。管理者に確認してください' using errcode='22023';
  end if;
  update app.items set tracking_no=tracking where id=t.accessory_item_id
    and is_accessory and lot_seq=t.lot_seq and deliverer_id=t.recipient_staff_id;
  if not found then raise exception '発送先の付属品が変更されています' using errcode='22023'; end if;
  update app.spare_shipping_tasks set tracking_no=tracking,sent_at=now() where id=t.id;
end $$;
revoke all on function app.send_spare_shipping(uuid,text) from public,anon;
grant execute on function app.send_spare_shipping(uuid,text) to authenticated;

create function app.complete_spare_shipping(p_task_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者のみ完了できます' using errcode='42501';
  end if;
  update app.spare_shipping_tasks set completed_at=coalesce(completed_at,now())
    where id=p_task_id and sent_at is not null;
  if not found then raise exception '発送済みのタスクが見つかりません' using errcode='22023'; end if;
end $$;
grant update(completed_at) on app.spare_shipping_tasks to authenticated;
create policy spare_shipping_complete on app.spare_shipping_tasks for update to authenticated
using(app.is_admin() and sent_at is not null) with check(app.is_admin() and sent_at is not null);
revoke all on function app.complete_spare_shipping(uuid) from public,anon;
grant execute on function app.complete_spare_shipping(uuid) to authenticated;

-- Register the input item and its reserve accessory in one transaction.
create or replace function app.register_item_with_spare(p_item jsonb, p_spare_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_input app.items;
  v_item app.items;
  v_accessory app.items;
  v_spare app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '在庫を登録する権限がありません' using errcode='42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' or p_spare_id is null then
    raise exception '登録情報が不正です' using errcode='22023';
  end if;
  -- Serialize this operation without expanding spare-table write privileges.
  perform pg_advisory_xact_lock(hashtextextended(p_spare_id::text, 179051));
  select * into v_spare from app.spare_accessories where id=p_spare_id and used_for_item_id is null;
  if not found or (not app.is_admin() and v_spare.owner_staff_id is distinct from app.current_staff_id()) then
    raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023';
  end if;
  if v_spare.linked_item_id is not null and exists(select 1 from app.items where id=v_spare.linked_item_id) then
    raise exception 'この予備には在庫行が残っています。二重登録を避けるため予備の登録内容を確認してください' using errcode='22023';
  end if;
  v_input := jsonb_populate_record(null::app.items,p_item);
  if coalesce(v_input.is_accessory,false) and not exists(select 1 from app.items where lot_seq=v_input.lot_seq and not is_accessory) then
    raise exception 'この通番号の本体が見つかりません。本体を先に登録してください' using errcode='22023';
  end if;
  insert into app.items (sku,lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,
    title,cost_amount,marketplace,marketplace_item_id,marketplace_url,card_id,tracking_no,product_id,
    asin,condition,accessories,description,planned_price,planned_payout,sales_channel,status,memo,source_purchase_draft_id)
  values (v_input.sku,v_input.lot_seq,coalesce(v_input.is_accessory,false),v_input.purchaser_id,v_input.deliverer_id,
    v_input.work_stream,v_input.purchased_at,v_input.title,v_input.cost_amount,v_input.marketplace,
    v_input.marketplace_item_id,v_input.marketplace_url,v_input.card_id,v_input.tracking_no,v_input.product_id,
    v_input.asin,v_input.condition,v_input.accessories,v_input.description,v_input.planned_price,v_input.planned_payout,
    v_input.sales_channel,coalesce(v_input.status,'作業中'::app.item_status),v_input.memo,v_input.source_purchase_draft_id)
  returning * into v_item;
  perform app.allocate_spare_accessory(p_spare_id,v_item.id);
  if not v_item.is_accessory then
    insert into app.items (lot_seq,is_accessory,purchaser_id,deliverer_id,work_stream,purchased_at,title,
      cost_amount,marketplace,marketplace_item_id,tracking_no,asin,sales_channel,memo)
    values (v_item.lot_seq,true,coalesce(v_spare.owner_staff_id,v_item.purchaser_id),v_item.deliverer_id,'付属品',
      v_spare.purchased_at,v_spare.title,v_spare.cost_amount,
      case when v_spare.marketplace in (select unnest(enum_range(null::app.marketplace))::text)
        then v_spare.marketplace::app.marketplace else 'その他'::app.marketplace end,
      v_spare.marketplace_item_id,v_spare.tracking_no,v_spare.asin,v_item.sales_channel,
      v_spare.usage_note)
    returning * into v_accessory;
  end if;
  perform app.queue_spare_shipping(p_spare_id,v_item.id,coalesce(v_accessory.id,v_item.id));
  return jsonb_build_object('id',v_item.id,'sku',v_item.sku,'accessory_sku',v_accessory.sku);
end;
$$;
revoke all on function app.register_item_with_spare(jsonb,uuid) from public,anon;
grant execute on function app.register_item_with_spare(jsonb,uuid) to authenticated;
