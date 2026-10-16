-- Compact conditional reads preserve existing table/view RLS and role restrictions.
create or replace function app.read_resource_snapshot(p_resource text,p_filters jsonb default '{}',p_known jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare source text; result jsonb;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_resource in ('invoice_tasks','photo_reviews','listing_tasks','actions') and not app.is_admin() then raise exception '管理者のみ閲覧できます' using errcode='42501';end if;
 case p_resource
 when 'spares' then source:=$q$select to_jsonb(s)||jsonb_build_object('_owner_code',p.code) d from app.spare_accessories s left join app.staff p on p.id=s.owner_staff_id where s.used_for_item_id is null and (nullif($1->>'owner','') is null or s.owner_staff_id::text=$1->>'owner')$q$;
 when 'shipping' then source:=$q$select to_jsonb(s) d from app.v_spare_shipping_tasks s where completed_at is null$q$;
 when 'actions' then source:=$q$select to_jsonb(s) d from app.v_item_action_tasks s where task_completed_at is null$q$;
 when 'malfunctions' then source:=$q$select to_jsonb(s) d from (select i.id,i.sku,i.lot_seq,i.title,i.asin,i.marketplace_item_id,i.purchaser_id,i.deliverer_id,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_reported_by,
 jsonb_build_array(jsonb_build_object('model_no',p.model_no)) products,coalesce(p.maker,a.maker) maker,
 jsonb_build_array(jsonb_build_object('id',b.id,'name',b.name),jsonb_build_object('id',d.id,'name',d.name),jsonb_build_object('id',r.id,'name',r.name)) people
 from app.items i left join app.products p on p.id=i.product_id left join app.products a on a.asin=i.asin and a.is_active
 left join app.staff b on b.id=i.purchaser_id left join app.staff d on d.id=i.deliverer_id left join app.staff r on r.id=i.malfunction_reported_by
 where i.malfunction_reported and i.malfunction_resolved_at is null and (app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))) s$q$;
 when 'photo_reviews' then source:=$q$select jsonb_build_object('id',r.item_id,'item_id',r.item_id,'drive_folder_id',r.drive_folder_id,'submitted_at',r.submitted_at,'exported_photo_count',r.exported_photo_count,'item',jsonb_build_object('id',i.id,'sku',i.sku,'title',i.title,'lot_seq',i.lot_seq)) d from app.photo_reviews r join app.items i on i.id=r.item_id where r.approved_at is null$q$;
 when 'listing_tasks' then source:=$q$select to_jsonb(i) d from (select i.id,i.sku,i.lot_seq,i.sales_channel from app.items i join app.photo_reviews r on r.item_id=i.id where r.approved_at is not null and i.sales_channel in ('メルカリ','ヤフオク') and i.status='商品登録前' and i.sold_on is null) i$q$;
 when 'invoice_tasks' then source:=$q$select jsonb_build_object('id',coalesce(i.staff_id,s.staff_id)::text||'/'||coalesce(i.billing_month,s.billing_month)::text,'staff_id',coalesce(i.staff_id,s.staff_id),'month',coalesce(i.billing_month,s.billing_month),'name',coalesce(i.snapshot->'profile'->>'issuer_name',p.details->>'issuer_name','担当者'),'updated',greatest(i.updated_at,s.submitted_at),
 'invoice',case when i.id is null then null else to_jsonb(i)||jsonb_build_object('delivery_invoice_approvals',(select to_jsonb(a) from app.delivery_invoice_approvals a where a.invoice_id=i.id limit 1)) end,'receipts',to_jsonb(s)) d
 from app.delivery_invoices i full join app.invoice_receipt_submissions s on s.staff_id=i.staff_id and s.billing_month=i.billing_month left join app.delivery_invoice_profiles p on p.staff_id=coalesce(i.staff_id,s.staff_id)$q$;
 else raise exception '取得対象を確認してください' using errcode='22023';end case;
 execute 'with rows as materialized (select d,md5(d::text) hash from ('||source||') source),summary as(select coalesce(jsonb_agg(d->>''id'' order by d->>''id''),''[]''::jsonb) ids,coalesce(jsonb_object_agg(d->>''id'',hash),''{}''::jsonb) fingerprints,coalesce(jsonb_agg(d order by d->>''id'') filter(where ($2->>(d->>''id'')) is distinct from hash),''[]''::jsonb) rows,md5(coalesce(string_agg((d->>''id'')||hash,'','' order by d->>''id''),'''')) revision from rows)
 select case when $2->>''__revision''=revision then jsonb_build_object(''unchanged'',true,''revision'',revision,''ids'',''[]''::jsonb,''rows'',''[]''::jsonb,''fingerprints'',''{}''::jsonb)
 else jsonb_build_object(''unchanged'',false,''revision'',revision,''ids'',ids,''rows'',rows,''fingerprints'',fingerprints) end from summary'
 into result using coalesce(p_filters,'{}'),coalesce(p_known,'{}');return result;
end $$;
revoke all on function app.read_resource_snapshot(text,jsonb,jsonb) from public,anon;
grant execute on function app.read_resource_snapshot(text,jsonb,jsonb) to authenticated;

-- Keep the product-list average identical to the prior latest-three Amazon calculation.
create or replace function app.product_sale_summaries(p_product_ids uuid[])
returns jsonb language sql stable security invoker set search_path=pg_catalog,app as $$
 with sales as (
 select p.id product_id,i.id,i.sold_on,i.sold_price,i.sales_channel from app.products p join app.items i on i.product_id=p.id or (i.product_id is null and i.asin=p.asin)
 where p.id=any(p_product_ids) and not i.is_accessory and i.sold_on is not null
 ),amazon as(select *,row_number() over(partition by product_id order by sold_on desc,id) n from sales where sales_channel in ('FBA','自己発送') and sold_price is not null)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',p.id,'history_count',(select count(*) from sales s where s.product_id=p.id),'amazon_count',(select count(*) from amazon a where a.product_id=p.id and n<=3),'amazon_average',(select floor(avg(sold_price)+0.5) from amazon a where a.product_id=p.id and n<=3))),'[]'::jsonb)
 from app.products p where p.id=any(p_product_ids) and auth.uid() is not null
$$;
revoke all on function app.product_sale_summaries(uuid[]) from public,anon;
grant execute on function app.product_sale_summaries(uuid[]) to authenticated;

-- List rows carry a revision of detail-only text, so an open detail can revalidate it.
do $$declare definition text;marker text:='coalesce(jsonb_agg(d order by n) filter';begin
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Inventory projection insertion point missing';end if;
 definition:=replace(definition,marker,$replacement$coalesce(jsonb_agg(case when $1='delivery' then (d-'description'-'malfunction_comment')||jsonb_build_object('description',null,'malfunction_comment',null,'summary_only',true,'detail_revision',md5(jsonb_build_array(d->'description',d->'malfunction_comment')::text)) else d end order by n) filter$replacement$);
 execute definition;
end $$;
