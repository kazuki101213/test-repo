alter table app.payment_cards add column expense_only boolean not null default false;

insert into app.payment_cards (name, expense_only)
values ('Amazon売上金', true)
on conflict (name) do update set expense_only = true, is_active = true;

notify pgrst,'reload schema';
