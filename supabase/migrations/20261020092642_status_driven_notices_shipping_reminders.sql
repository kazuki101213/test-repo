create or replace function app.capture_shipping_request() returns trigger language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status not in ('取引中','販売済') or new.shipped_on is not null or not coalesce(new.sales_channel in ('メルカリ','ヤフオク','自己発送'),false) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif new.status='取引中' and old.status is distinct from new.status and not exists(select 1 from app.delivery_shipping_tasks where item_id=new.id and resolved_at is null) then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;

create or replace view app.v_delivery_notice_tasks with(security_invoker=true) as
 with notices as (
  select t.id::text id,t.item_id,case when t.kind='malfunction_return' then 'reply' else t.kind end kind,
   t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,t.reason
  from app.delivery_return_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null
  union all
  select 'approved:'||i.id::text||':'||extract(epoch from r.approved_at)::text,i.id,'photo_approved',
   r.approved_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is not null and i.status='商品登録前' and i.product_registered_at is null and i.sold_on is null
  union all
  select 'reply:'||c.id::text,i.id,'reply',c.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,c.body
  from app.item_comments c join app.items i on i.id=c.item_id join app.staff s on s.id=c.author_id
  where s.role in ('admin','purchaser') and c.created_at>i.malfunction_reported_at
   and not exists(select 1 from app.delivery_return_tasks t where t.id=c.id)
  union all
  select 'shipping:'||t.id::text,i.id,'shipping',t.created_at,i.sku,i.lot_seq,i.marketplace_item_id,i.marketplace,i.marketplace_url,null::text
  from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id
  where t.resolved_at is null and i.status in ('取引中','販売済') and i.shipped_on is null
   and i.sales_channel in ('メルカリ','ヤフオク','自己発送')
 ), latest as (
  select distinct on(item_id,kind) * from notices order by item_id,kind,created_at desc,id
 )
 select n.id,n.item_id,n.kind,n.created_at,n.sku,n.lot_seq,n.marketplace_item_id,n.marketplace,n.marketplace_url,
  -- Keep the view column for compatibility, with no expiration value or timer.
  null::timestamptz expires_at,n.reason
 from latest n
 where auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;




-- Reuse the bounded snapshot and its existing RLS, with an explicit admin guard.
do $migration$
declare original text;patched text;
begin
 select pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure) into original;
 patched:=replace(original,$old$when 'listing_tasks' then$old$,$new$when 'admin_shipping_tasks' then
  if not app.is_admin() then raise exception '管理者のみ閲覧できます' using errcode='42501';end if;
  source:=$shipping$select to_jsonb(s) d from (select t.id,i.id item_id,i.sku,i.lot_seq,i.sales_channel,i.marketplace,i.marketplace_item_id,i.marketplace_url,t.created_at from app.delivery_shipping_tasks t join app.items i on i.id=t.item_id where t.resolved_at is null and t.created_at<=now()-interval '24 hours' and i.status in ('取引中','販売済') and i.shipped_on is null and i.sales_channel in ('メルカリ','ヤフオク','自己発送')) s$shipping$;
 when 'listing_tasks' then$new$);
 if patched=original then raise exception 'Snapshot listing branch changed';end if;
 execute patched;
end $migration$;
