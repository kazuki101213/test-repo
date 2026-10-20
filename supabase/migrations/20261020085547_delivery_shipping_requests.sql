-- One informational request per trading episode; completion never ships an item.
create table app.delivery_shipping_tasks (
 id uuid primary key default gen_random_uuid(),item_id uuid not null references app.items(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),resolved_at timestamptz
);
create unique index delivery_shipping_tasks_active on app.delivery_shipping_tasks(item_id) where resolved_at is null;
alter table app.delivery_shipping_tasks enable row level security;
revoke all on app.delivery_shipping_tasks from public,anon,authenticated;
grant select on app.delivery_shipping_tasks to authenticated;
grant all on app.delivery_shipping_tasks to service_role;
create policy delivery_shipping_tasks_read on app.delivery_shipping_tasks for select to authenticated using (
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id()))
);

alter table app.delivery_push_events drop constraint delivery_push_events_kind_check;
alter table app.delivery_push_events add constraint delivery_push_events_kind_check
 check(kind in ('reply','photo','assigned','photo_return','malfunction_return','shipping'));

create function app.capture_shipping_request() returns trigger language plpgsql security definer set search_path=pg_catalog,app as $$
declare task app.delivery_shipping_tasks;
begin
 if new.is_accessory and not app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 if new.status<>'取引中' or new.shipped_on is not null or new.sales_channel not in ('メルカリ','ヤフオク','自己発送') then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
 elsif old.status is distinct from new.status then
  update app.delivery_shipping_tasks set resolved_at=clock_timestamp() where item_id=new.id and resolved_at is null;
  insert into app.delivery_shipping_tasks(item_id) values(new.id) returning * into task;
  perform app.enqueue_delivery_push(new.id,'shipping',task.created_at,app.current_staff_id());
 end if;
 return new;
end $$;
revoke all on function app.capture_shipping_request() from public,anon,authenticated;
create trigger items_capture_shipping_request after update of status,shipped_on,sales_channel on app.items
 for each row execute function app.capture_shipping_request();

-- Current unshipped trades receive cards, without historical push broadcasts.
insert into app.delivery_shipping_tasks(item_id)
 select id from app.items where status='取引中' and shipped_on is null and sales_channel in ('メルカリ','ヤフオク','自己発送')
 and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq));

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
  -- Keep the view column for compatibility, with no expiration value or timer.
  null::timestamptz expires_at,n.reason
 from latest n
 where auth.uid() is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=app.current_staff_id() and c.notice_id=n.id);
revoke all on app.v_delivery_notice_tasks from public,anon;
grant select on app.v_delivery_notice_tasks to authenticated,service_role;


-- Keep all existing dispatch checks and delivery-only subscription routing.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.claim_delivery_push()'::regprocedure);
 patched:=replace(original,'and case e.kind','and case e.kind'||chr(10)||
  ' when ''shipping'' then i.status=''取引中'' and i.shipped_on is null and i.sales_channel in (''メルカリ'',''ヤフオク'',''自己発送'') and exists(select 1 from app.delivery_shipping_tasks t where t.item_id=i.id and t.created_at=e.event_at and t.resolved_at is null and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=st.id and c.notice_id=''shipping:''||t.id::text and c.item_id=i.id))');
 if patched=original then raise exception 'Shipping push eligibility anchor missing';end if;
 execute patched;
end $patch$;
notify pgrst,'reload schema';
