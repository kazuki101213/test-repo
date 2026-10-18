-- Workload metrics only: leave the global stock/financial definitions unchanged.
-- Append the new SQL column to preserve the existing view column identities and grants.
create or replace view app.v_deliverer_workload with (security_invoker=true,security_barrier=true) as
with dates as (
 select (now() at time zone 'Asia/Tokyo')::date today,
 ((now() at time zone 'Asia/Tokyo')::date-interval '3 months')::date average_start
)
select s.id deliverer_id,s.name deliverer_name,
 count(*) filter(where not i.is_accessory and (
   i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良')
   or (i.sales_channel in ('自己発送','メルカリ','ヤフオク') and
      (i.status='出品中' or (i.status='取引中' and i.shipped_on is null)))
 )) as "保有在庫",
 avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null
   and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数",
 count(*) filter(where not i.is_accessory and i.status in ('検品中','Amazon返送依頼','商品登録前')) as "作業在庫"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active and (select app.management_reports_allowed()) group by s.id,s.name;
