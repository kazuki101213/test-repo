create table app.delivery_invoice_profiles (
 staff_id uuid primary key references app.staff(id),
 details jsonb not null check(jsonb_typeof(details)='object'),
 unit_price integer check(unit_price between 0 and 1000000),
 tax_percent integer not null default 0 check(tax_percent in (0,10)),
 enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
create table app.delivery_invoices (
 id uuid primary key default gen_random_uuid(),
 staff_id uuid not null references app.staff(id),
 billing_month date not null check(extract(day from billing_month)=1),
 issued_on date not null default (now() at time zone 'Asia/Tokyo')::date,
 extras jsonb not null default '[]'::jsonb check(jsonb_typeof(extras)='array'),
 note text not null default '' check(length(note)<=2000),
 snapshot jsonb not null,
 total bigint not null,
 version integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(staff_id,billing_month)
);
alter table app.delivery_invoice_profiles enable row level security;
alter table app.delivery_invoices enable row level security;
revoke all on app.delivery_invoice_profiles,app.delivery_invoices from public,anon,authenticated;
grant select on app.delivery_invoice_profiles,app.delivery_invoices to authenticated;
grant insert(staff_id,billing_month,issued_on,extras,note) on app.delivery_invoices to authenticated;
grant update(issued_on,extras,note) on app.delivery_invoices to authenticated;
create policy invoice_profiles_read on app.delivery_invoice_profiles for select to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
create policy invoices_read on app.delivery_invoices for select to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
create policy invoices_insert on app.delivery_invoices for insert to authenticated
 with check (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));
create policy invoices_update on app.delivery_invoices for update to authenticated
 using (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())))
 with check (exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and (staff_id=(select app.current_staff_id()) or (select app.is_admin())));

create function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception '請求書へのアクセス権がありません' using errcode='42501';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 -- One body per lot, regardless of supplier rows. Accessories never increase quantity.
 with bodies as (
 select distinct on (lot_seq) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title
 from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
 order by lot_seq,packed_on,id
 ), selected as (
 select * from bodies where packed_on>=p_month and packed_on<p_month+interval '1 month'
 )
 select coalesce(jsonb_agg(jsonb_build_object(
 'item_id',id,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
 'description',case when marketplace::text='Amazon返品' then 'Amazon返品対応'
 when work_stream::text='テレビ' then 'モニター・テレビ'
 when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
 'title',title,'quantity',1,'unit_price',p.unit_price,'amount',p.unit_price
 ) order by purchased_at nulls last,lot_seq),'[]'::jsonb),count(*)*p.unit_price into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

create function app.fill_delivery_invoice()
returns trigger language plpgsql security invoker set search_path=pg_catalog,app as $$
declare doc jsonb; line jsonb; normalized jsonb:='[]'; qty integer; price bigint; sub bigint; tax bigint; date_value date;
begin
 if jsonb_typeof(new.extras)<>'array' or jsonb_array_length(new.extras)>100 then raise exception '追加明細は100行以内で入力してください'; end if;
 doc:=app.prepare_delivery_invoice(new.staff_id,new.billing_month);
 sub:=(doc->>'subtotal')::bigint;
 for line in select value from jsonb_array_elements(new.extras) loop
  if jsonb_typeof(line)<>'object' or length(trim(coalesce(line->>'description','')))=0 or length(line->>'description')>200
  or coalesce(line->>'quantity','') !~ '^[0-9]+$' or coalesce(line->>'unit_price','') !~ '^[0-9]+$' then
   raise exception '追加明細の内容・数量・単価を確認してください';
  end if;
  qty:=(line->>'quantity')::integer; price:=(line->>'unit_price')::bigint;
  if qty<1 or qty>100000 or price<0 or price>10000000 then raise exception '追加明細の金額が範囲外です'; end if;
  date_value:=nullif(line->>'date','')::date;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('date',date_value,'description',trim(line->>'description'),'quantity',qty,'unit_price',price,'amount',qty*price));
  sub:=sub+qty*price;
 end loop;
 tax:=floor(sub*(doc->>'tax_percent')::numeric/100);
 new.extras:=normalized;
 new.snapshot:=doc||jsonb_build_object('extras',normalized,'subtotal',sub,'tax',tax);
 new.total:=sub+tax;
 new.updated_at:=clock_timestamp();
 if tg_op='UPDATE' then new.version:=old.version+1; else new.version:=1; end if;
 return new;
end $$;
revoke all on function app.fill_delivery_invoice() from public,anon,authenticated;
create trigger fill_delivery_invoice before insert or update on app.delivery_invoices for each row execute function app.fill_delivery_invoice();
notify pgrst,'reload schema';
