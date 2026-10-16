-- Preserve assignee labels and working-return tracking, using one origin lookup per serial.
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
 origins as (select distinct on (d->>'lot_seq') d->>'lot_seq' lot,d->>'marketplace_item_id' item_id from raw
  where not (d->>'is_accessory')::boolean and d->>'sku' ~ '^[0-9]+-' and nullif(d->>'marketplace_item_id','') is not null order by d->>'lot_seq',d->>'id'),
 data as materialized (
  select r.d || case when $1='delivery' then jsonb_build_object(
   'original_marketplace_item_id',o.item_id,'deliverer_name',s.name,
   'tracking_no',coalesce(nullif(r.d->>'tracking_no',''),case when r.d->>'marketplace'='動作品Amazon返品' and btrim(r.d->>'title') ~ '^X[A-Z0-9]{9}$' then btrim(r.d->>'title') else r.d->>'tracking_no' end)) else '{}'::jsonb end d,
   coalesce(lower(substring(r.d->>'sku' from '^([0-9]+[a-zA-Z]*)[-_]')),r.d->>'lot_seq') serial
  from raw r left join origins o on $1='delivery' and o.lot=r.d->>'lot_seq'
  left join app.staff s on $1='delivery' and s.id::text=r.d->>'deliverer_id'
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
