create extension if not exists pg_cron with schema pg_catalog;
create table app.expense_drafts (
 id uuid primary key default gen_random_uuid(),
 target_month date not null check (extract(day from target_month)=1),
 name text not null check (length(trim(name))>0),
 card_id uuid references app.payment_cards(id),
 created_at timestamptz not null default now(),
 unique(target_month,name)
);
alter table app.expense_drafts enable row level security;
revoke all on app.expense_drafts from anon, authenticated;
grant select on app.expense_drafts to authenticated;
create policy expense_drafts_admin_read on app.expense_drafts for select to authenticated using(app.is_admin());
create function app.generate_next_month_fixed_expenses() returns integer language plpgsql security invoker set search_path = pg_catalog,app as $$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,name,card_id)
 select next_month,src.name,src.card_id from (
 select distinct on (name) name,card_id from (
 select name,card_id,updated_at from app.expenses where category='固定費' and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where e.category='固定費' and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
select cron.schedule('next-month-fixed-expense-drafts','55 14 * * *','select app.generate_next_month_fixed_expenses()');
notify pgrst,'reload schema';
