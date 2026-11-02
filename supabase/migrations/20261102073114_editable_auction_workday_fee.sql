-- Preserve per-day fees from the shared invoice form; keep date and owner guards.
create or replace function app.fill_delivery_invoice()
returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare doc jsonb; line jsonb; normalized jsonb:='[]'; qty integer; price bigint; sub bigint; tax bigint; date_value date;
  is_ishikawa boolean; gross bigint:=0; percent_amount bigint:=0; base_amount bigint:=0;
begin
 if jsonb_typeof(new.extras)<>'array' or jsonb_array_length(new.extras)>100 then raise exception '追加明細は100行以内で入力してください'; end if;
 doc:=app.prepare_delivery_invoice(new.staff_id,new.billing_month);
 sub:=(doc->>'subtotal')::bigint;
 is_ishikawa:=doc->'profile'->>'issuer_name'='石川秀樹';
 if is_ishikawa then
  gross:=coalesce((app.monthly_gross_profit_by_purchaser(new.staff_id,new.billing_month)->>'total')::bigint,0);
 end if;
 for line in select value from jsonb_array_elements(new.extras) loop
  if jsonb_typeof(line)<>'object' or length(trim(coalesce(line->>'description','')))=0 or length(line->>'description')>200
  or coalesce(line->>'quantity','') !~ '^[0-9]+$' or coalesce(line->>'unit_price','') !~ '^[0-9]+$' then
   raise exception '追加明細の内容・数量・単価を確認してください';
  end if;
  if line->>'description'='粗利益連動調整' then continue; end if;
  qty:=(line->>'quantity')::integer; price:=(line->>'unit_price')::bigint;
  date_value:=nullif(line->>'date','')::date;
  if line->>'description'='ヤフオク入札作業日' then
   if not is_ishikawa or qty<>1 or price<0 or price>10000000 or date_value is null
    or date_value<new.billing_month or date_value>=new.billing_month+interval '1 month' then
    raise exception 'ヤフオク入札作業日は石川秀樹の対象月内の日付で登録してください';
   end if;
   if exists(select 1 from jsonb_array_elements(normalized) x where x->>'description'='ヤフオク入札作業日' and x->>'date'=date_value::text) then
    raise exception '同じ作業日が重複しています';
   end if;
   normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description','ヤフオク入札作業日','quantity',1,'unit_price',price,'amount',price));
   base_amount:=base_amount+price; sub:=sub+price;
   continue;
  end if;
  if qty<1 or qty>100000 or price<0 or price>10000000 then raise exception '追加明細の金額が範囲外です'; end if;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description',trim(line->>'description'),'quantity',qty,'unit_price',price,'amount',qty*price));
  sub:=sub+qty*price;
 end loop;
 if is_ishikawa then
  percent_amount:=floor(greatest(gross,0)*0.10)::bigint;
  if percent_amount>base_amount then
   normalized:=normalized||jsonb_build_array(jsonb_build_object('date',null,'description','粗利益連動調整','quantity',1,'unit_price',percent_amount-base_amount,'amount',percent_amount-base_amount));
   sub:=sub+(percent_amount-base_amount);
  end if;
 end if;
 tax:=floor(sub*(doc->>'tax_percent')::numeric/100);
 new.extras:=normalized;
 new.snapshot:=doc||jsonb_build_object('extras',normalized,'subtotal',sub,'tax',tax);
 new.total:=sub+tax;
 new.updated_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_delivery_invoice() from public,anon,authenticated;

notify pgrst,'reload schema';
