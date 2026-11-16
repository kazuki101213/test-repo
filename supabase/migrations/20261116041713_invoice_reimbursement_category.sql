alter table app.invoice_receipts
  add column category text
  constraint invoice_reimbursement_category
  check (category in ('配送費', '旅費交通費', '梱包資材費', '消耗品費', 'その他'));
grant insert(category), update(category) on app.invoice_receipts to authenticated;

create or replace function app.lock_invoice_receipt_changes() returns trigger
language plpgsql security invoker set search_path=pg_catalog,app as $$
declare who uuid; target date; invoice uuid;
begin
  if tg_op='DELETE' then
    who:=old.staff_id; target:=old.billing_month;
  else
    who:=new.staff_id; target:=new.billing_month;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(who::text||target::text,0));

  if tg_table_name='invoice_receipts' and tg_op<>'DELETE' then
    -- One-time classification of historical rows must preserve their submitted version.
    if tg_op='UPDATE' and current_user='postgres' and session_user='postgres'
      and current_setting('app.backfill_reimbursement_category', true)='on'
      and old.category is null and new.category is not null
      and (to_jsonb(new)-'category')=(to_jsonb(old)-'category') then
      return new;
    end if;
    if new.include_in_invoice and new.category is null
      and (tg_op='INSERT' or not old.include_in_invoice or old.category is not null) then
      raise exception '区分を選択してください。' using errcode='23514';
    end if;
  end if;

  select id into invoice from app.delivery_invoices where staff_id=who and billing_month=target for update;
  if invoice is not null and exists(select 1 from app.delivery_invoice_approvals where invoice_id=invoice) then
    raise exception '承認済み請求書の領収書は変更できません';
  end if;
  if tg_op='UPDATE' and tg_table_name='invoice_receipts' then new.version:=old.version+1; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;

do $$
begin
  perform set_config('app.backfill_reimbursement_category','on',true);
  update app.invoice_receipts
  set category='配送費'
  where include_in_invoice and category is null
    and trim(description) ~ '^(クリックポスト代|着払い|宅急便コンパクト代)$|^配送(費|料)([（(]|$)';
  update app.invoice_receipts
  set category='梱包資材費'
  where include_in_invoice and category is null
    and trim(description) in ('巻きダンボール', 'ゆうパケットプラス専用箱', '宅急便コンパクト用箱代');
  perform set_config('app.backfill_reimbursement_category','off',true);
end $$;

notify pgrst,'reload schema';
