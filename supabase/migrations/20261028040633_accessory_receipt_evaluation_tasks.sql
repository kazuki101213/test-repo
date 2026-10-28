-- Keep receipt work separate from the accessory's actual inspection history.
create function app.receipt_purchase_market(p_marketplace app.marketplace)
returns text language sql immutable strict set search_path='' as $$
 select case when p_marketplace in ('ヤフフリ','PayPayフリマ') then 'Yahoo!フリマ' else p_marketplace::text end
$$;
revoke all on function app.receipt_purchase_market(app.marketplace) from public,anon;
grant execute on function app.receipt_purchase_market(app.marketplace) to authenticated,service_role;

create function app.enqueue_accessory_receipt_tasks(p_parent_id uuid,p_requested_at timestamptz)
returns void language sql security definer set search_path='' as $$
 insert into app.receipt_evaluation_tasks(item_id,requested_at)
 select i.id,p_requested_at from app.items i join app.items parent on parent.id=i.parent_item_id
 where parent.id=p_parent_id and not parent.is_accessory and i.is_accessory and i.id<>parent.id
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
  select id,new.created_at from app.items where id=new.item_id and marketplace in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ')
  on conflict(item_id) do update set requested_at=excluded.requested_at where receipt_evaluation_tasks.completed_at is null;
  perform app.enqueue_accessory_receipt_tasks(new.item_id,new.created_at);
 end if;
 return new;
end $$;

-- Also handle a separate purchase linked after the parent's inspection.
-- Imported completion dates alone must not create receipt requests.
create function app.enqueue_linked_accessory_receipt_task() returns trigger
language plpgsql security definer set search_path='' as $$
declare requested timestamptz;
begin
 if new.is_accessory and new.parent_item_id is not null then
  select max(created_at) into requested from app.inventory_workflow_events
   where item_id=new.parent_item_id and action='inspection_complete';
  if requested is not null then perform app.enqueue_accessory_receipt_tasks(new.parent_item_id,requested);end if;
 end if;
 return new;
end $$;
revoke all on function app.enqueue_linked_accessory_receipt_task() from public,anon,authenticated;
create trigger linked_accessory_receipt_task after insert or update of parent_item_id,is_accessory,marketplace,marketplace_item_id
on app.items for each row execute function app.enqueue_linked_accessory_receipt_task();

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
 where t.completed_at is null
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

-- Backfill only explicitly completed, still-inspected parents; completion ledgers are preserved.
do $$declare parent record;begin
 for parent in select e.item_id,max(e.created_at) requested_at from app.inventory_workflow_events e
 join app.items i on i.id=e.item_id
 where e.action='inspection_complete' and not i.is_accessory and i.inspected_at is not null and i.cleaned_at is not null
 and exists(select 1 from app.items child where child.parent_item_id=i.id and child.is_accessory)
 group by e.item_id
 loop perform app.enqueue_accessory_receipt_tasks(parent.item_id,parent.requested_at);end loop;
end $$;
notify pgrst,'reload schema';
