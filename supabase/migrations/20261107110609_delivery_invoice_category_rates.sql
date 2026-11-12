-- These rates are administered separately from the self-editable invoice profile.
alter table app.delivery_invoice_profiles add column category_rates jsonb;
revoke update(category_rates) on app.delivery_invoice_profiles from public,anon,authenticated;

update app.delivery_invoice_profiles p
set category_rates = v.rates
from app.staff s
join (values
 ('KK','{"from_month":"2026-11-01","monitor":450,"bluray":500}'::jsonb),
 ('MM','{"from_month":"2026-11-01","monitor":450,"bluray":500,"trial":400}'::jsonb)
) v(code,rates) on s.code=v.code
where p.staff_id=s.id;

create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint; rates jsonb; trial_price bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception '請求書へのアクセス権がありません' using errcode='42501';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception '請求単価の設定を管理者に確認してください'; end if;
 if p_month >= (p.category_rates->>'from_month')::date then
  rates := p.category_rates;
  if p_month < coalesce((rates->>'trial_until')::date, 'infinity'::date) then
   trial_price := (rates->>'trial')::bigint;
  end if;
 end if;
 with invoice_items as (
  select distinct on(lower(app.product_serial(sku,lot_seq))) id,sku,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,
   app.product_serial(sku,lot_seq) as serial_key,
   app.is_standalone_accessory_serial(sku,lot_seq) as standalone,
   (lower(app.product_serial(sku,lot_seq)) ~ '^[0-9]+[ab]*b$' or marketplace::text='動作品Amazon返品') as half_return
  from app.items where deliverer_id=p_staff and packed_on is not null
    and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq))
  order by lower(app.product_serial(sku,lot_seq)),packed_on,id
 ), priced as (
  select *,coalesce(trial_price,case work_stream::text
   when 'テレビ' then (rates->>'monitor')::bigint
   when 'ブルーレイ' then (rates->>'bluray')::bigint
  end,p.unit_price::bigint) as base_price
  from invoice_items where packed_on>=p_month and packed_on<p_month+interval '1 month'
 ), selected as (
  select *,case when standalone or half_return then base_price/2 else base_price end as price
  from priced
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'item_id',id,'sku',sku,'serial',serial_key,'lot_seq',lot_seq,'date',purchased_at,'packed_on',packed_on,
  'description',case when standalone then '付属品単体販売' when half_return then '動作品Amazon返品対応'
   when marketplace::text='Amazon返品' then 'Amazon返品対応' when work_stream::text='テレビ' then 'モニター・テレビ'
   when work_stream::text='ブルーレイ' then 'ブルーレイレコーダー' else '小物' end,
  'title',title,'quantity',1,'unit_price',price,'amount',price
 ) order by purchased_at nulls last,lot_seq,serial_key,id),'[]'::jsonb),coalesce(sum(price),0)
 into lines,subtotal from selected;
 return jsonb_build_object('profile',p.details,'lines',lines,'subtotal',subtotal,'tax_percent',p.tax_percent);
end $$;
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;
notify pgrst,'reload schema';
