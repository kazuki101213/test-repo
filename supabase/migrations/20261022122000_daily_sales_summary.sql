-- Preserve the chart's serial grouping and financial-family counts under caller RLS.
create function app.read_daily_sales_summary(p_from date,p_to date) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from+1>36600 then raise exception '開始日・終了日を確認してください。期間は100年以内で指定してください。' using errcode='22023';end if;
 with rows as materialized (
  select s.*,upper(coalesce(substring(s.sku from '^([0-9]+[a-zA-Z]*)[-_]'),s.lot_seq::text)) chart_serial
  from app.v_financial_sales s
 ), sales as (
  select * from rows where sold_on is not null and (nullif(family_key,'') is not null
   or not(is_accessory and coalesce(sold_price,0)=0 and coalesce(payout_amount,0)=0))
 ), grouped as (
  select chart_serial,(array_agg(family_key order by id))[1] family,
   count(distinct jsonb_build_array(sold_on,sold_price,payout_amount))>1 or bool_or(sold_price is null) conflict
  from sales group by chart_serial
 ), chosen as (
  select distinct on(chart_serial) chart_serial,sold_on,sold_price from sales
  order by chart_serial,is_accessory,id
 ), totals as (
  select c.sold_on,sum(coalesce(c.sold_price,0)) amount,count(distinct coalesce(g.family,g.chart_serial)) count
  from chosen c join grouped g using(chart_serial)
  where not g.conflict and c.sold_on between p_from and p_to group by c.sold_on
 ), days as (
  select d::date date,coalesce(t.amount,0) amount,coalesce(t.count,0) count
  from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d left join totals t on t.sold_on=d::date
 ), conflicts as (
  select g.chart_serial from grouped g where g.conflict and exists(select 1 from sales s
   where s.chart_serial=g.chart_serial and s.sold_on between p_from and p_to)
 )
 select jsonb_build_object('days',(select jsonb_agg(to_jsonb(d) order by d.date) from days d),
  'conflicts',coalesce((select jsonb_agg(chart_serial order by chart_serial) from conflicts),'[]'::jsonb)) into result;
 return result;
end $$;
revoke all on function app.read_daily_sales_summary(date,date) from public,anon;
grant execute on function app.read_daily_sales_summary(date,date) to authenticated;
