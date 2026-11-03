-- Retain expense identities and approval/reconciliation links; exclude deleted rows from accounting.
create table app.expense_deletion_batches (
 id uuid primary key,
 entries jsonb not null check (jsonb_typeof(entries)='array'),
 deleted_by uuid not null default app.current_staff_id() references app.staff(id),
 created_at timestamptz not null default now()
);
alter table app.expense_deletion_batches enable row level security;
revoke all on app.expense_deletion_batches from public,anon,authenticated;
grant select,insert on app.expense_deletion_batches to authenticated;
create policy expense_deletion_batches_read on app.expense_deletion_batches for select to authenticated using ((select app.is_admin()));
create policy expense_deletion_batches_insert on app.expense_deletion_batches for insert to authenticated with check ((select app.is_admin()) and deleted_by=(select app.current_staff_id()));
alter table app.expenses add column deleted_at timestamptz, add column deletion_batch uuid references app.expense_deletion_batches(id);
alter table app.expense_drafts add column deleted_at timestamptz;
grant update(deleted_at) on app.expense_drafts to authenticated;
create policy expense_drafts_admin_delete on app.expense_drafts for update to authenticated using ((select app.is_admin())) with check ((select app.is_admin()));

create function app.delete_expenses(p_rows jsonb,p_request_id uuid) returns integer
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare input jsonb; current_row app.expenses; inserted integer; batch app.expense_deletion_batches;
 normalized jsonb; expected jsonb;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '経費を削除できるのは管理者だけです' using errcode='42501';
 end if;
 if p_request_id is null or p_rows is null or jsonb_typeof(p_rows)<>'array' then raise exception '削除する経費の指定が不正です' using errcode='22023';end if;
 if jsonb_array_length(p_rows)<1 or jsonb_array_length(p_rows)>1000 then raise exception '削除する経費は1〜1,000件で指定してください' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'id','') is null)
 or (select count(distinct r->>'id') from jsonb_array_elements(p_rows) r)<>jsonb_array_length(p_rows) then raise exception '削除する経費の指定が重複または不正です' using errcode='22023';end if;
 select jsonb_agg(r order by r->>'id') into normalized from jsonb_array_elements(p_rows) r;
 insert into app.expense_deletion_batches(id,entries) values(p_request_id,normalized) on conflict(id) do nothing;
 get diagnostics inserted=row_count;
 if inserted=0 then
  select * into batch from app.expense_deletion_batches where id=p_request_id;
  if batch.deleted_by<>app.current_staff_id() or batch.entries<>normalized then raise exception '前回の削除内容と異なります。確認画面を閉じて選択し直してください' using errcode='22023';end if;
  return jsonb_array_length(normalized);
 end if;
 for input in select value from jsonb_array_elements(normalized) loop
  select * into current_row from app.expenses where id=(input->>'id')::uuid for update;
  if not found or current_row.deleted_at is not null then raise exception '経費が変更または削除されています。確認画面を閉じて一覧を読み直してください' using errcode='40001';end if;
  expected:=jsonb_build_object('id',current_row.id,'incurred_on',current_row.incurred_on,'category',current_row.category,'name',current_row.name,'amount',current_row.amount,'card_id',current_row.card_id,'staff_id',current_row.staff_id,'memo',current_row.memo);
  if expected<>input then raise exception '経費が変更されています。確認画面を閉じて一覧を読み直してください' using errcode='40001';end if;
  update app.expenses set deleted_at=now(),deletion_batch=p_request_id where id=current_row.id;
  update app.expense_drafts set deleted_at=now() where id=current_row.id;
 end loop;
 return jsonb_array_length(normalized);
end $$;
revoke all on function app.delete_expenses(jsonb,uuid) from public,anon,authenticated;
grant execute on function app.delete_expenses(jsonb,uuid) to authenticated;

-- Patch only the expense source, preserving the current report authorization and financial calculations.
do $$
declare definition text;
begin
 definition:=pg_get_viewdef('app.v_monthly_summary'::regclass,true);
 if length(definition)-length(replace(definition,'FROM app.expenses',''))<>length('FROM app.expenses') then raise exception 'Unexpected monthly expense source';end if;
 definition:=replace(definition,'FROM app.expenses','FROM app.expenses WHERE expenses.deleted_at IS NULL');
 execute 'create or replace view app.v_monthly_summary as '||definition;
end $$;

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
 select name,card_id,updated_at from app.expenses where deleted_at is null and category::text='固定費' and incurred_on>=month_start and incurred_on<next_month
 union all
 select d.name,d.card_id,d.created_at from app.expense_drafts d
 where d.deleted_at is null and d.category='固定費' and d.target_month=month_start and not exists(select 1 from app.expenses e where e.id=d.id)
 ) candidates order by name,updated_at desc
 ) src
 where not exists(select 1 from app.expenses e where e.deleted_at is null and e.category::text='固定費' and e.name=src.name and e.incurred_on>=next_month and e.incurred_on<next_month+interval '1 month')
 on conflict(target_month,category,name) do nothing;
 get diagnostics inserted = row_count;
 return inserted;
end $$;
revoke all on function app.generate_next_month_fixed_expenses() from public,anon,authenticated;
