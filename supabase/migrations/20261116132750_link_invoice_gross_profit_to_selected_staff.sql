-- Invoice filters can select a purchaser or a delivery assignee.
create or replace function app.monthly_gross_profit_by_purchaser(p_purchaser_id uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare
 current_id uuid := app.current_staff_id();
 current_user_role text := app.current_role();
 target_id uuid := current_id;
 target_role text := current_user_role;
 result jsonb;
begin
 if auth.uid() is null or current_id is null or p_month is null or extract(day from p_month) <> 1 then
  raise exception '対象月またはログイン情報が不正です' using errcode='22023';
 end if;

 if current_user_role = 'admin' then
  select s.id,s.role into target_id,target_role from app.staff s where s.id=p_purchaser_id and s.is_active;
  if target_role is null or target_role not in ('admin','purchaser','deliverer') then
   raise exception '担当者を選択してください' using errcode='22023';
  end if;
 elsif (current_user_role = 'purchaser' and p_purchaser_id = current_id)
    or (current_user_role = 'deliverer' and p_purchaser_id is null) then
  target_id := current_id;
 else
  raise exception '閲覧する権限がありません' using errcode='42501';
 end if;

 with products as (
  select s.sku,s.sold_on,owner.name as purchaser_name,s.profit as gross_profit
  from app.v_financial_sales s
  join app.items event_item on event_item.id=s.id
  join app.items origin on origin.id=s.origin_item_id
  left join app.staff owner on owner.id=origin.purchaser_id
  where s.sold_on>=p_month and s.sold_on<p_month+interval '1 month'
    and ((target_role in ('admin','purchaser') and origin.purchaser_id=target_id)
      or (target_role='deliverer' and event_item.deliverer_id=target_id))
 )
 select jsonb_build_object(
  'rows',coalesce(jsonb_agg(jsonb_build_object('sku',sku,'sold_on',sold_on,'purchaser_name',purchaser_name,'gross_profit',gross_profit) order by sold_on,sku),'[]'::jsonb),
  'total',coalesce(sum(gross_profit),0)
 ) into result from products;
 return result;
end $$;
