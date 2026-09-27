create or replace function app.generate_next_month_fixed_expenses() returns integer language plpgsql security invoker set search_path=pg_catalog,app as $$
declare today_jst date := (now() at time zone 'Asia/Tokyo')::date;
 month_start date := date_trunc('month',today_jst)::date;
 next_month date := (month_start + interval '1 month')::date;
 inserted integer;
begin
 if today_jst <> next_month - 1 then return 0; end if;
 insert into app.expense_drafts(target_month,category,name,card_id)
 select next_month,'固定費',src.name,src.card_id from (
 select distinct on (name) name,card_id from (
 select name,card_id,updated_at from app.expenses where category::text='固定費' and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.category='固定費' and d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where e.category::text='固定費' and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,category,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
-- Remove only unfilled outsourcing placeholders; recorded expenses are preserved.
delete from app.expense_drafts d where d.category='外注費' and not exists(select 1 from app.expenses e where e.id=d.id);

create table app.delivery_invoice_approvals (
 invoice_id uuid primary key references app.delivery_invoices(id),
 expense_id uuid not null unique references app.expenses(id),
 approved_by uuid not null default app.current_staff_id() references app.staff(id),
 approved_at timestamptz not null default now()
);
alter table app.delivery_invoice_approvals enable row level security;
revoke all on app.delivery_invoice_approvals from public,anon,authenticated;
grant select on app.delivery_invoice_approvals to authenticated;
grant insert(invoice_id,expense_id) on app.delivery_invoice_approvals to authenticated;
create policy invoice_approvals_read on app.delivery_invoice_approvals for select to authenticated
 using (exists(select 1 from app.delivery_invoices i where i.id=invoice_id));
create policy invoice_approvals_insert on app.delivery_invoice_approvals for insert to authenticated
 with check ((select app.is_admin()) and exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and approved_by=app.current_staff_id());

create function app.block_approved_invoice_changes() returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
begin
 if exists(select 1 from app.delivery_invoice_approvals where invoice_id=old.id) then
  raise exception '承認済みの請求書は変更できません。管理者にご連絡ください。';
 end if;
 return new;
end $$;
revoke all on function app.block_approved_invoice_changes() from public,anon,authenticated;
create trigger a_block_approved_invoice_changes before update on app.delivery_invoices
 for each row execute function app.block_approved_invoice_changes();

create function app.approve_delivery_invoice(p_invoice uuid,p_version integer,p_incurred_on date)
returns uuid language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; existing uuid; expense uuid;
begin
 if auth.uid() is null or not app.is_admin()
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '請求書を承認できるのは管理者だけです' using errcode='42501';
 end if;
 select * into inv from app.delivery_invoices where id=p_invoice for update;
 if not found then raise exception '請求書が見つかりません'; end if;
 select expense_id into existing from app.delivery_invoice_approvals where invoice_id=inv.id;
 if found then return existing; end if;
 if inv.version<>p_version then raise exception '請求書が更新されました。最新の内容を確認してください'; end if;
 if p_incurred_on is null then raise exception '経費の計上日を指定してください'; end if;
 if inv.total<=0 then raise exception '請求金額が0円のため承認できません'; end if;
 insert into app.expenses(incurred_on,category,name,amount,staff_id,memo)
 values(p_incurred_on,'外注費',
 coalesce(inv.snapshot->'profile'->>'issuer_name','納品担当者')||' '||to_char(inv.billing_month,'YYYY年MM月')||' 請求書',
 inv.total,inv.staff_id,'納品請求書 '||inv.id::text) returning id into expense;
 insert into app.delivery_invoice_approvals(invoice_id,expense_id) values(inv.id,expense);
 return expense;
end $$;
revoke all on function app.approve_delivery_invoice(uuid,integer,date) from public,anon,authenticated;
grant execute on function app.approve_delivery_invoice(uuid,integer,date) to authenticated;
notify pgrst,'reload schema';
