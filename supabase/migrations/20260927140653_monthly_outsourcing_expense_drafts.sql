alter table app.expense_drafts add column category text not null default '固定費' check(category in ('固定費','外注費'));
alter table app.expense_drafts drop constraint expense_drafts_target_month_name_key;
alter table app.expense_drafts add unique(target_month,category,name);
create or replace function app.generate_next_month_fixed_expenses() returns integer language plpgsql security invoker set search_path=pg_catalog,app as $$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,category,name,card_id)
 select next_month,src.category,src.name,src.card_id from (
 select distinct on (category,name) category,name,card_id from (
 select case when category::text='給与' then '外注費' else category::text end as category,name,card_id,updated_at
 from app.expenses where category::text in ('固定費','給与','外注費') and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.category,d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by category,name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where (case when e.category::text='給与' then '外注費' else e.category::text end)=src.category
 and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,category,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
notify pgrst,'reload schema';
