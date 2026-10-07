-- Amazon返品 is a supplier category, not a work status.
-- Apply the same work-status rules to every supplier, without return dates.
create or replace function app.items_sync_status()
returns trigger language plpgsql set search_path = 'pg_catalog', 'app' as $$
begin
  if new.status in ('返品処理', '保留', '廃棄', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$$;

-- A historical Amazon-return marker must not prevent a new sale.
create or replace function app.items_mark_sold()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status = '販売済'
     and old.status in ('返品処理', '販売済')
     and new.returned_on is not null
     and new.returned_on is not distinct from old.returned_on then return new; end if;
  if new.sold_on is not null and not new.is_accessory and new.status <> '返品処理' then
    new.status := '販売済';
  end if;
  if new.returned_on is not null then new.status := '返品処理'; end if;
  return new;
end;
$$;

-- Change only the retired state. Retain supplier, source history and dates.
do $$ begin
  if exists(select 1 from app.items where status='Amazon返品' and marketplace is distinct from 'Amazon返品') then
    raise exception 'Unexpected supplier for retired Amazon-return status';
  end if;
end $$;
update app.items set status = case
  when sold_on is not null and (sold_price is not null or is_accessory) then '販売済'::app.item_status
  when shipped_on is not null then '出品中'::app.item_status
  else '作業中'::app.item_status end
where status = 'Amazon返品';

do $$
declare definition text;
begin
  definition := pg_get_viewdef('app.v_deliverer_workload'::regclass,true);
  definition := replace(definition,
    'i.status = ''作業中''::app.item_status OR i.status = ''Amazon返品''::app.item_status AND i.shipped_on IS NULL',
    'i.status = ''作業中''::app.item_status');
  if position('Amazon返品' in definition)>0 then raise exception 'Unexpected workload definition'; end if;
  execute 'create or replace view app.v_deliverer_workload as '||definition;
  definition := pg_get_viewdef('app.v_delivery_tasks'::regclass,true);
  definition := replace(definition,'''Amazon返品''::app.item_status, ','');
  execute 'create or replace view app.v_delivery_tasks as '||definition;
end $$;
alter table app.items add constraint items_no_amazon_return_work_status
  check(status <> 'Amazon返品'::app.item_status);

-- Keep Amazon sale reconciliation tied to the supplier category after retiring
-- its old work-status marker. Preserve all other matching/authorization logic.
do $$
declare definition text; old_condition text;
begin
  definition := pg_get_functiondef('app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid)'::regprocedure);
  old_condition := '(amazon_returned_on is not null or returned_on is not null or status in (''Amazon返品'',''返品処理''))';
  if position(old_condition in definition)=0 then raise exception 'Expected sale reconciliation condition missing'; end if;
  definition := replace(definition,old_condition,
    '(marketplace = ''Amazon返品'' or amazon_returned_on is not null or returned_on is not null or status in (''Amazon返品'',''返品処理''))');
  execute definition;
end $$;
