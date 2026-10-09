create or replace function app.guard_single_product_sale()
returns trigger language plpgsql set search_path=''
as 'declare serial_key text;
begin
  if tg_op=''UPDATE'' and new.sold_on is not distinct from old.sold_on
    and new.sold_price is not distinct from old.sold_price
    and new.payout_amount is not distinct from old.payout_amount then return new; end if;
  if new.sold_on is null then return new; end if;
  if new.is_accessory and app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new; end if;
  if new.is_accessory and coalesce(new.sold_price,0)=0 and coalesce(new.payout_amount,0)=0 then return new; end if;
  serial_key:=app.product_serial(new.sku,new.lot_seq);
  perform pg_advisory_xact_lock(hashtextextended(serial_key,179049));
  if exists (
    select 1 from app.items i
    where app.product_serial(i.sku,i.lot_seq)=serial_key
      and i.id<>new.id and i.sold_on is not null
      and not (i.is_accessory and coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0)
      and not app.is_standalone_accessory_serial(i.sku,i.lot_seq)
      and i.amazon_returned_on is null and i.returned_on is null
      and i.marketplace is distinct from ''Amazon返品'' and i.status<>''返品処理''
  ) then
    raise exception ''同じ商品番号の商品に販売記録があります。返品処理済みの履歴は保持し、重複販売を防止します。'';
  end if;
  return new;
end;';


-- C suffix accessories are standalone sales: include one invoice line at half the normal unit price.
create or replace function app.prepare_delivery_invoice(p_staff uuid,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as 'declare p app.delivery_invoice_profiles; lines jsonb; subtotal bigint;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false) then
  raise exception ''請求書へのアクセス権がありません'' using errcode=''42501'';
 end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception ''対象月が不正です''; end if;
 select * into p from app.delivery_invoice_profiles where staff_id=p_staff;
 if not found or not p.enabled or p.unit_price is null then raise exception ''請求単価の設定を管理者に確認してください''; end if;
 with invoice_items as (
   (select distinct on (lot_seq) id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,p.unit_price as unit_price
   from app.items
   where deliverer_id=p_staff and not is_accessory and packed_on is not null
   order by lot_seq,packed_on,id)
   union all
   select id,lot_seq,purchased_at,packed_on,work_stream,marketplace,title,floor(p.unit_price/2.0)::bigint
   from app.items
   where deliverer_id=p_staff and is_accessory
     and app.is_standalone_accessory_serial(sku,lot_seq)
     and packed_on is not null
 ), selected as (
   select * from invoice_items
   where packed_on>=p_month and packed_on<p_month+interval ''1 month''
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   ''item_id'',id,''lot_seq'',lot_seq,''date'',purchased_at,''packed_on'',packed_on,
   ''description'',case
     when app.is_standalone_accessory_serial((select sku from app.items where id=invoice_items.id),lot_seq)
       then ''付属品単体販売''
     when marketplace::text=''Amazon返品'' then ''Amazon返品対応''
     when work_stream::text=''テレビ'' then ''モニター・テレビ''
     when work_stream::text=''ブルーレイ'' then ''ブルーレイレコーダー'' else ''小物'' end,
   ''title'',title,''quantity'',1,''unit_price'',unit_price,''amount'',unit_price
 ) order by purchased_at nulls last,lot_seq,id),''[]''::jsonb),
 count(*)*p.unit_price into lines,subtotal from selected;
 select coalesce(sum((value->>''amount'')::bigint),0) into subtotal from jsonb_array_elements(lines);
 return jsonb_build_object(''profile'',p.details,''lines'',lines,''subtotal'',subtotal,''tax_percent'',p.tax_percent);
end';
revoke all on function app.prepare_delivery_invoice(uuid,date) from public,anon,authenticated;
grant execute on function app.prepare_delivery_invoice(uuid,date) to authenticated;

notify pgrst, 'reload schema';

