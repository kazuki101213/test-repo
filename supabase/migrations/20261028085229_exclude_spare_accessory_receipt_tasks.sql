-- Spare allocations are internal stock transfers, not new purchases to evaluate.
create function app.receipt_item_is_spare_accessory(p_item app.items)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce((p_item).is_accessory,false) and (
  exists(select 1 from app.spare_accessories s where s.used_for_item_id=(p_item).id or s.linked_item_id=(p_item).id
   or (s.used_for_item_id=(p_item).parent_item_id and nullif(btrim((p_item).marketplace_item_id),'') is not null
    and s.marketplace_item_id=(p_item).marketplace_item_id
    and case when s.marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else s.marketplace end=app.receipt_purchase_market((p_item).marketplace)))
  or exists(select 1 from app.spare_shipping_tasks s where s.accessory_item_id=(p_item).id)
 )
$$;
revoke all on function app.receipt_item_is_spare_accessory(app.items) from public,anon;
grant execute on function app.receipt_item_is_spare_accessory(app.items) to authenticated,service_role;

create or replace function app.enqueue_accessory_receipt_tasks(p_parent_id uuid,p_requested_at timestamptz)
returns void language sql security definer set search_path='' as $$
 insert into app.receipt_evaluation_tasks(item_id,requested_at)
 select i.id,p_requested_at from app.items i join app.items parent on parent.id=i.parent_item_id
 where parent.id=p_parent_id and not parent.is_accessory and i.is_accessory and i.id<>parent.id
 and not app.receipt_item_is_spare_accessory(i)
 and parent.inspected_at is not null and parent.cleaned_at is not null
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and nullif(btrim(i.marketplace_item_id),'') is not null
 and row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
   is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id)
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and d.marketplace_item_id=i.marketplace_item_id
   and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
 on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null
$$;
revoke all on function app.enqueue_accessory_receipt_tasks(uuid,timestamptz) from public,anon,authenticated;

create or replace function app.enqueue_inspection_receipt_task() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.action='inspection_complete' then
  insert into app.receipt_evaluation_tasks(item_id,requested_at)
  select i.id,new.created_at from app.items i where i.id=new.item_id and not app.receipt_item_is_spare_accessory(i) and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
  on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null;
  perform app.enqueue_accessory_receipt_tasks(new.item_id,new.created_at);
 end if;
 return new;
end $$;

-- Existing pending rows are hidden without erasing their history.
create or replace view app.v_receipt_evaluation_tasks with(security_invoker=true) as
with eligible as (
 select t.item_id as id,t.item_id,t.requested_at,i.sku,i.lot_seq,i.title,p.model_no,i.asin,
 i.marketplace,i.marketplace_item_id,i.marketplace_url,i.is_accessory,
 row_number() over(partition by app.receipt_purchase_market(i.marketplace),
   coalesce(nullif(btrim(i.marketplace_item_id),''),i.id::text)
   order by i.is_accessory,t.requested_at,i.id) as purchase_rank
 from app.receipt_evaluation_tasks t join app.items i on i.id=t.item_id
 left join app.products p on p.id=i.product_id
 left join app.items parent on parent.id=i.parent_item_id and not parent.is_accessory and parent.id<>i.id
 where t.completed_at is null and not app.receipt_item_is_spare_accessory(i)
 and ((i.inspected_at is not null and i.cleaned_at is not null)
   or (i.is_accessory and parent.inspected_at is not null and parent.cleaned_at is not null))
 and (not i.is_accessory or parent.id is null
   or row(app.receipt_purchase_market(i.marketplace),i.marketplace_item_id)
     is distinct from row(app.receipt_purchase_market(parent.marketplace),parent.marketplace_item_id))
 and i.marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
 and not exists(select 1 from app.marketplace_extension_receipts r
   where r.marketplace=app.receipt_purchase_market(i.marketplace) and r.marketplace_item_id=i.marketplace_item_id and r.state='succeeded')
 and not exists(select 1 from app.receipt_evaluation_tasks done join app.items d on d.id=done.item_id
   where done.completed_at is not null and nullif(btrim(i.marketplace_item_id),'') is not null
   and d.marketplace_item_id=i.marketplace_item_id and app.receipt_purchase_market(d.marketplace)=app.receipt_purchase_market(i.marketplace))
)
select id,item_id,requested_at,sku,lot_seq,title,model_no,asin,marketplace,marketplace_item_id,marketplace_url,is_accessory
from eligible where purchase_rank=1;

create or replace function app.complete_receipt_evaluation_task(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '管理者のみ操作できます' using errcode='42501';
 end if;
 if exists(select 1 from app.items i where i.id=p_item_id and app.receipt_item_is_spare_accessory(i)) then
  raise exception '予備・付属品から割り当てた付属品は受取評価の対象外です' using errcode='22023';
 end if;
 if not exists(select 1 from app.receipt_evaluation_tasks where item_id=p_item_id) then
  raise exception '受取評価のやることがありません' using errcode='22023';
 end if;
 update app.receipt_evaluation_tasks t
 set completed_at=coalesce(t.completed_at,clock_timestamp()),completed_by=coalesce(t.completed_by,app.current_staff_id())
 from app.items i,app.items target
 where i.id=t.item_id and target.id=p_item_id
 and (i.id=target.id or (nullif(btrim(target.marketplace_item_id),'') is not null
   and i.marketplace_item_id=target.marketplace_item_id
   and app.receipt_purchase_market(i.marketplace)=app.receipt_purchase_market(target.marketplace)));
end $$;

notify pgrst,'reload schema';
