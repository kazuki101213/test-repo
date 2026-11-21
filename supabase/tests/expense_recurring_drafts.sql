-- 登録した経費は、前月に入力がなくても月末に翌月の入力待ちが作られる。
begin;
set local role postgres;
insert into app.expense_recurring_drafts(name) values ('Recurring fixture') on conflict do nothing;
do $$
declare n integer;
begin
  if not exists (select 1 from app.expense_recurring_drafts where name = 'OPEN AI') then raise exception 'OPEN AI not registered'; end if;
  if not exists (select 1 from app.expense_recurring_drafts where name = 'ANTHROPIC') then raise exception 'ANTHROPIC not registered'; end if;
  if strpos(pg_get_functiondef('app.generate_next_month_fixed_expenses'::regproc), 'expense_recurring_drafts') = 0 then raise exception 'Generator ignores recurring drafts'; end if;
end $$;
set local role authenticated;
do $$begin
  begin perform 1 from app.expense_recurring_drafts; raise exception 'Client read recurring settings';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
