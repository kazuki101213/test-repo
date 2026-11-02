-- Admin invoice corrections are separate from inventory/work source records.
alter table app.delivery_invoices add column review_content jsonb
 check(review_content is null or jsonb_typeof(review_content)='object');

create function app.normalize_invoice_review_lines(p_lines jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare line jsonb; normalized jsonb:='[]'; qty integer; price bigint; day date;
begin
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)>300 then
  raise exception '明細は300行以内で入力してください';
 end if;
 for line in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(line)<>'object' or length(trim(coalesce(line->>'description','')))=0
   or length(line->>'description')>200 or coalesce(line->>'quantity','') !~ '^[0-9]{1,6}$'
   or coalesce(line->>'unit_price','') !~ '^[0-9]{1,8}$' then
   raise exception '明細・数量・単価を確認してください';
  end if;
  qty:=(line->>'quantity')::integer; price:=(line->>'unit_price')::bigint;
  if qty<1 or qty>100000 or price>10000000 then raise exception '数量・単価が範囲外です'; end if;
  day:=nullif(line->>'date','')::date;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('date',day,'description',trim(line->>'description'),
   'quantity',qty,'unit_price',price,'amount',qty::bigint*price));
 end loop;
 return normalized;
end $$;
revoke all on function app.normalize_invoice_review_lines(jsonb) from public,anon,authenticated;

-- Preserve subsequent, explicit extra-line edits from the existing delivery form.
create function app.keep_invoice_review_extras() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.review_content is not null and new.review_content=old.review_content and new.extras is distinct from old.extras then
  new.review_content:=jsonb_set(new.review_content,'{extras}',new.extras);
 end if;
 return new;
end $$;
revoke all on function app.keep_invoice_review_extras() from public,anon,authenticated;
create trigger b_keep_invoice_review_extras before update on app.delivery_invoices
 for each row execute function app.keep_invoice_review_extras();

create function app.apply_invoice_review_content() returns trigger
language plpgsql set search_path='' as $$
declare sub bigint; tax bigint;
begin
 if new.review_content is null then return new; end if;
 select coalesce(sum((x->>'quantity')::bigint*(x->>'unit_price')::bigint),0) into sub
 from jsonb_array_elements((new.review_content->'lines')||(new.review_content->'extras')) x;
 tax:=floor(sub*(old.snapshot->>'tax_percent')::numeric/100);
 new.extras:=new.review_content->'extras';
 new.snapshot:=old.snapshot||jsonb_build_object('lines',new.review_content->'lines','extras',new.extras,
  'subtotal',sub,'tax',tax,'review_edited',true);
 new.total:=sub+tax;
 return new;
end $$;
revoke all on function app.apply_invoice_review_content() from public,anon,authenticated;
-- Existing z_fill_invoice_receipt_lines adds current reimbursements after this.
create trigger y_apply_invoice_review_content before update on app.delivery_invoices
 for each row execute function app.apply_invoice_review_content();

create function app.admin_edit_invoice(p_invoice uuid,p_version integer,p_receipt_version integer,
 p_issued date,p_lines jsonb,p_extras jsonb,p_receipts jsonb,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare inv app.delivery_invoices; who uuid; target date; submitted integer; rec jsonb; stored app.invoice_receipts;
 normalized_lines jsonb; normalized_extras jsonb; changed boolean:=false; price bigint; day date;
begin
 if auth.uid() is null or not coalesce(app.is_admin(),false)
  or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then
  raise exception '請求書を編集できるのは管理者だけです' using errcode='42501';
 end if;
 select staff_id,billing_month into who,target from app.delivery_invoices where id=p_invoice;
 if not found then raise exception '請求書が見つかりません'; end if;
 perform pg_advisory_xact_lock(hashtextextended(who::text||target::text,0));
 select * into inv from app.delivery_invoices where id=p_invoice for update;
 if exists(select 1 from app.delivery_invoice_approvals where invoice_id=p_invoice) then
  raise exception '承認済みの請求書は編集できません';
 end if;
 if inv.version is distinct from p_version then raise exception '請求書が更新されました。開き直してください'; end if;
 select version into submitted from app.invoice_receipt_submissions where staff_id=who and billing_month=target;
 if submitted is distinct from p_receipt_version
  or coalesce(inv.snapshot->'receipt_lines','[]'::jsonb) is distinct from app.invoice_receipt_lines(who,target) then
  raise exception '領収書が更新されました。請求書を再送信してから開き直してください';
 end if;
 if p_issued is null or p_note is null or length(p_note)>2000 then raise exception '日付・備考を確認してください'; end if;
 normalized_lines:=app.normalize_invoice_review_lines(p_lines);
 normalized_extras:=app.normalize_invoice_review_lines(p_extras);
 if p_receipts is null or jsonb_typeof(p_receipts)<>'array'
  or jsonb_array_length(p_receipts)<>jsonb_array_length(coalesce(inv.snapshot->'receipt_lines','[]'::jsonb))
  or (select count(distinct x->>'id') from jsonb_array_elements(p_receipts) x)<>jsonb_array_length(p_receipts) then
  raise exception '領収書の明細を開き直してください';
 end if;
 for rec in select value from jsonb_array_elements(p_receipts) loop
  select * into stored from app.invoice_receipts where id=(rec->>'id')::uuid and staff_id=who and billing_month=target
   and include_in_invoice and document_type<>'invoice' for update;
  if not found or stored.version is distinct from (rec->>'version')::integer then
   raise exception '領収書が更新されました。開き直してください';
  end if;
  if length(trim(coalesce(rec->>'description','')))=0 or length(rec->>'description')>200
   or coalesce(rec->>'amount','') !~ '^[0-9]{1,8}$' then raise exception '領収書の明細・単価を確認してください'; end if;
  price:=(rec->>'amount')::bigint; day:=nullif(rec->>'spent_on','')::date;
  if price>10000000 or day is null then raise exception '領収書の日付・単価を確認してください'; end if;
  if (stored.spent_on,stored.description,stored.amount) is distinct from (day,trim(rec->>'description'),price) then
   update app.invoice_receipts set spent_on=day,description=trim(rec->>'description'),amount=price where id=stored.id;
   changed:=true;
  end if;
 end loop;
 if changed and submitted is not null then
  update app.invoice_receipt_submissions set submitted_at=clock_timestamp() where staff_id=who and billing_month=target
   returning version into submitted;
 end if;
 update app.delivery_invoices set issued_on=p_issued,note=p_note,
  review_content=jsonb_build_object('lines',normalized_lines,'extras',normalized_extras)
 where id=p_invoice returning * into inv;
 return jsonb_build_object('invoice',to_jsonb(inv),'receipt_version',submitted);
end $$;
revoke all on function app.admin_edit_invoice(uuid,integer,integer,date,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function app.admin_edit_invoice(uuid,integer,integer,date,jsonb,jsonb,jsonb,text) to authenticated;
notify pgrst,'reload schema';
