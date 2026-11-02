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
 values:=f->'delivererIds';
 if f ? 'delivererIds' and jsonb_typeof(values)<>'array' then raise exception '納品担当者の条件が不正です' using errcode='22023';end if;
 if jsonb_typeof(values)='array' and jsonb_array_length(values)>0 and not values ? coalesce(d->>'deliverer_id','') then return false;end if;
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

