-- Keep the existing column order and 今月出荷 compatibility alias for old clients.
create or replace view app.v_deliverer_workload as
with dates as (
 select (now() at time zone 'Asia/Tokyo')::date as today,
 date_trunc('month',now() at time zone 'Asia/Tokyo')::date as month_start,
 ((now() at time zone 'Asia/Tokyo')::date - interval '3 months')::date as average_start
)
select s.id as deliverer_id,s.name as deliverer_name,
 count(*) filter(where not i.is_accessory and i.status='作業中') as "作業中",
 count(*) filter(where not i.is_accessory and i.shipped_on between d.month_start and d.today) as "今月出荷",
 count(*) filter(where not i.is_accessory and i.status='作業中') as "手元在庫",
 avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null
   and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数",
 count(*) filter(where not i.is_accessory and i.packed_on between d.month_start and d.today) as "梱包済",
 count(*) filter(where not i.is_accessory and i.shipped_on between d.month_start and d.today) as "出荷済",
 count(*) filter(where not i.is_accessory and i.packed_on is null) as "梱包前"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active group by s.id,s.name
order by count(*) filter(where not i.is_accessory and i.status='作業中') desc;
notify pgrst,'reload schema';
