-- Read-only, RLS-preserving snapshots. A page is a prefix of complete serial groups.
-- Fingerprints include joined catalog/comments/photo metadata, not just items.updated_at.
create or replace function app.inventory_page_matches(d jsonb,f jsonb,scope text)
returns boolean language plpgsql immutable set search_path=pg_catalog,app as $$
declare field text; needle text; candidate text; serial text; values jsonb;
begin
 foreach field in array array['status','marketplace','sales_channel'] loop
  values:=f->'states'->field;
  if jsonb_typeof(values)='array' and jsonb_array_length(values)>0 and not values ? coalesce(d->>field,'') then return false;end if;
 end loop;
 if nullif(f->>'status','') is not null and f->>'status'<>'all' and d->>'status'<>f->>'status' then return false;end if;
 if nullif(f->>'delivererId','') is not null and coalesce(d->>'deliverer_id','')<>f->>'delivererId' then return false;end if;
 if nullif(f->>'from','') is not null and coalesce(d->>'purchased_at','')<f->>'from' then return false;end if;
 if nullif(f->>'to','') is not null and (d->>'purchased_at' is null or d->>'purchased_at'>f->>'to') then return false;end if;
 field:=coalesce(f->>'queryField','serial');needle:=coalesce(f->>'query','');
 if scope='delivery' then needle:=regexp_replace(lower(normalize(needle,NFKC)),'[[:space:]‐‑–—−ー]','','g');else needle:=lower(btrim(needle));end if;
 if needle='' or field='deliverer' then return true;end if;
 serial:=coalesce(substring(d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]'),d->>'lot_seq');
 candidate:=case field when 'serial' then serial when 'model' then
  case when scope='management' and (d->>'is_accessory')::boolean then d->>'title'
   else coalesce(nullif(btrim(d->>'model_no'),''),case when d->>'marketplace'='動作品Amazon返品' then '未登録' else coalesce(nullif(btrim(d->>'title'),''),'—') end) end
  when 'marketplace_item_id' then case when scope='delivery' and d->>'marketplace'<>'動作品Amazon返品' then coalesce(nullif(d->>'original_marketplace_item_id',''),d->>'marketplace_item_id') else d->>'marketplace_item_id' end
  when 'sku' then d->>'sku' when 'asin' then d->>'asin' when 'tracking_no' then d->>'tracking_no' else '' end;
 if scope='delivery' then candidate:=regexp_replace(lower(normalize(coalesce(candidate,''),NFKC)),'[[:space:]‐‑–—−ー]','','g');else candidate:=lower(coalesce(candidate,''));end if;
 if field='serial' then
  needle:=lower(btrim(normalize(needle,NFKC)));
  if needle ~ '^[0-9]+$' then return candidate ~ ('^'||needle||'[a-z]*$');end if;
  return candidate=needle;
 end if;
 return position(needle in candidate)>0;
end $$;
revoke all on function app.inventory_page_matches(jsonb,jsonb,text) from public,anon;
grant execute on function app.inventory_page_matches(jsonb,jsonb,text) to authenticated;

create or replace function app.read_inventory_page(p_scope text,p_filters jsonb default '{}',p_limit integer default 50,p_known jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,app as $$
declare source text; result jsonb; query text;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 if p_scope not in ('delivery','management') or p_limit<1 or p_limit>10000 or jsonb_typeof(p_filters)<>'object' or jsonb_typeof(p_known)<>'object' then raise exception '取得条件を確認してください' using errcode='22023';end if;
 -- Only whitelisted view names are interpolated; filters and fingerprints stay parameters.
 source:=case when p_scope='delivery' then 'app.v_delivery_tasks' else 'app.v_inventory_display' end;
 query:=format($query$
 with raw as materialized (select to_jsonb(v) d from %s v),
 data as materialized (
  select r.d || case when $1='delivery' then jsonb_build_object('original_marketplace_item_id',
   (select o.d->>'marketplace_item_id' from raw o where not (o.d->>'is_accessory')::boolean
    and o.d->>'lot_seq'=r.d->>'lot_seq' and o.d->>'sku' ~ '^[0-9]+-' and nullif(o.d->>'marketplace_item_id','') is not null order by o.d->>'id' limit 1)) else '{}'::jsonb end d,
   coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq') serial
  from raw r
 ),
 matched as materialized (select * from data where app.inventory_page_matches(d,$2,$1)),
 groups as (select serial,max((d->>'lot_seq')::integer) lot,max(d->>'purchased_at') purchased from matched group by serial),
 page_groups as (select * from groups order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial limit $3),
 page as materialized (
  select d.*,md5(d.d::text) fingerprint,g.lot,g.purchased from
  (select * from data where $1='delivery' union all select * from matched where $1='management') d
  join page_groups g using(serial)
 ),
 ordered as (select *,row_number() over(order by case when $1='delivery' then purchased end desc nulls last,lot desc,serial,(d->>'is_accessory')::boolean,d->>'id') n from page)
 select jsonb_build_object(
  'total',(select count(*) from groups),
  'ids',coalesce(jsonb_agg(d->>'id' order by n),'[]'::jsonb),
  'fingerprints',coalesce(jsonb_object_agg(d->>'id',fingerprint),'{}'::jsonb),
  'rows',coalesce(jsonb_agg(d order by n) filter(where ($4->>(d->>'id')) is distinct from fingerprint),'[]'::jsonb)
 ) from ordered
 $query$,source);
 execute query into result using p_scope,coalesce(p_filters,'{}'),p_limit,coalesce(p_known,'{}');
 return result;
end $$;
revoke all on function app.read_inventory_page(text,jsonb,integer,jsonb) from public,anon;
grant execute on function app.read_inventory_page(text,jsonb,integer,jsonb) to authenticated;
