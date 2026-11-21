-- OPEN AI と ANTHROPIC を、毎月「日付・金額の入力待ち」として未反映分に追加する（2026-11-22 ユーザー指定）。
-- 月末の自動作成はこれまで「当月の固定費」と「未入力の入力待ち」を翌月へ引き継ぐだけだったので、
-- 一度入力が途切れると止まっていた。ここに登録した経費は毎月必ず入力待ちを作る。
create table if not exists app.expense_recurring_drafts (
  name text primary key check (length(btrim(name)) > 0),
  category text not null default '固定費' check (category in ('固定費','外注費')),
  card_id uuid references app.payment_cards(id),
  created_at timestamptz not null default now()
);
alter table app.expense_recurring_drafts enable row level security;
revoke all on app.expense_recurring_drafts from anon, authenticated;

insert into app.expense_recurring_drafts(name, category, card_id)
select v.name, '固定費', (select id from app.payment_cards where name = 'セゾンカード' order by id limit 1)
from (values ('OPEN AI'), ('ANTHROPIC')) v(name)
on conflict (name) do nothing;

create or replace function app.generate_next_month_fixed_expenses()
 returns integer
 language plpgsql
 set search_path to 'pg_catalog', 'app'
as $function$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,category,name,card_id)
 select next_month,src.category,src.name,src.card_id from (
  select distinct on (category,name) category,name,card_id from (
   select '固定費'::text category,name,card_id,updated_at from app.expenses where deleted_at is null and category::text='固定費' and incurred_on>=month_start and incurred_on<next_month
   union all
   select d.category,d.name,d.card_id,d.created_at from app.expense_drafts d
   where d.deleted_at is null and d.category='固定費' and d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
   union all
   -- 毎月必ず入力待ちにする経費（OPEN AI・ANTHROPIC など）。
   select r.category,r.name,r.card_id,'-infinity'::timestamptz from app.expense_recurring_drafts r
  ) candidates order by category,name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where e.deleted_at is null and e.category::text=src.category and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,category,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $function$;

-- 今月（2026年11月）の分もすぐに未反映分へ出す。
insert into app.expense_drafts(target_month, category, name, card_id)
select date_trunc('month', (now() at time zone 'Asia/Tokyo'))::date, r.category, r.name, r.card_id
from app.expense_recurring_drafts r
where not exists (select 1 from app.expenses e where e.deleted_at is null and e.category::text = r.category and e.name = r.name
  and e.incurred_on >= date_trunc('month', (now() at time zone 'Asia/Tokyo'))::date
  and e.incurred_on < (date_trunc('month', (now() at time zone 'Asia/Tokyo')) + interval '1 month')::date)
on conflict (target_month, category, name) do nothing;
