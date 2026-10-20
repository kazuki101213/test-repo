-- Only the four explicit faulty-photo templates change the inventory condition.
-- Keep the existing actor, ownership, state and sold-item guards.
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  update app.items set
   workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;
