create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
  union all
  select 'shipping:'||t.id::text,i.id,'shipping',t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
  where t.resolved_at is null and i.status='取引中' and i.shipped_on is null
   and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Only listing and shipping requests expire after 72 hours.
  case when n.kind in ('photo_approved','shipping') then n.created_at+interval '72 hours' else null::timestamptz end expires_at,n.reason
 from latest n
 where (n.kind not in ('photo_approved','shipping') or n.created_at+interval '72 hours'>now())
  and auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;


