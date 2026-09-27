create function app.packed_product_summary(p_staff uuid,p_month date default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare result jsonb;
begin
 if auth.uid() is null or not coalesce(p_staff=app.current_staff_id() or app.is_admin(),false)
 or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '閲覧する権限がありません' using errcode='42501'; end if;
 if p_month is not null and extract(day from p_month)<>1 then raise exception '対象月が不正です'; end if;
 with bodies as (
 select distinct on(lot_seq) id,lot_seq,purchased_at,packed_on,title,sku
 from app.items where deliverer_id=p_staff and not is_accessory and packed_on is not null
 order by lot_seq,packed_on,id
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'lot_seq',lot_seq,'purchased_at',purchased_at,'packed_on',packed_on,'title',title,'sku',sku) order by packed_on desc,lot_seq desc),'[]'::jsonb)
 into result from bodies where p_month is null or (packed_on>=p_month and packed_on<p_month+interval '1 month');
 return result;
end $$;
revoke all on function app.packed_product_summary(uuid,date) from public,anon,authenticated;
grant execute on function app.packed_product_summary(uuid,date) to authenticated;

create function app.approve_invoice_documents(p_invoice uuid,p_version integer,p_receipt_version integer,p_incurred_on date)
returns uuid language plpgsql security invoker set search_path=pg_catalog,app as $$
declare inv app.delivery_invoices; actual integer; result uuid;
begin
 if not coalesce(app.is_admin(),false) or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '承認する権限がありません' using errcode='42501'; end if;
 select * into inv from app.delivery_invoices where id=p_invoice;
 if not found then raise exception '請求書が見つかりません'; end if;
 perform pg_advisory_xact_lock(hashtextextended(inv.staff_id::text||inv.billing_month::text,0));
 select version into actual from app.invoice_receipt_submissions where staff_id=inv.staff_id and billing_month=inv.billing_month;
 if actual is distinct from p_receipt_version then raise exception '領収書が再提出されています。タスクを開き直してください'; end if;
 select app.approve_delivery_invoice(p_invoice,p_version,p_incurred_on) into result;
 return result;
end $$;
revoke all on function app.approve_invoice_documents(uuid,integer,integer,date) from public,anon,authenticated;
grant execute on function app.approve_invoice_documents(uuid,integer,integer,date) to authenticated;
notify pgrst,'reload schema';
