-- Replace legacy literals in stored PL/pgSQL bodies after the enum rename.
do $$ declare r record; begin
 for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='app' and p.prokind='f' and pg_get_functiondef(p.oid) like '%作業中%' loop
 execute replace(pg_get_functiondef(r.oid),'作業中','受取前');
 end loop;
end $$;
alter table app.items add column if not exists return_request_completed_at timestamptz;
alter table app.items add column if not exists marketplace_status_observed_at timestamptz;
drop trigger if exists items_create_delivery_return_request_task on app.items;
-- Preserve completed request history; no further return-request tasks are generated.
update app.items i set return_request_completed_at=x.completed_at
from (select item_id,max(completed_at) completed_at from app.delivery_return_request_tasks
where completed_at is not null group by item_id) x where i.id=x.item_id;
create or replace function app.items_sync_status() returns trigger
language plpgsql set search_path=pg_catalog,app as $$
declare explicit_change boolean:=false; parent_status app.item_status;
begin
 if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.cost_amount:=0;end if;
 if new.is_accessory and new.parent_item_id is not null then
   select status into parent_status from app.items where id=new.parent_item_id;
   if found then new.status:=parent_status;return new;end if;
 end if;
 -- Sale dates always win, including delayed browser snapshots and photo actions.
 if new.sold_on is not null then new.status:='販売済';return new;end if;
 if new.status='返品処理' or new.returned_on is not null then new.status:='返品処理';return new;end if;
 if tg_op='UPDATE' then explicit_change:=new.status is distinct from old.status;end if;
 if explicit_change then
   if new.marketplace_status_observed_at is not distinct from old.marketplace_status_observed_at then new.marketplace_status_observed_at:=now();end if;
   if new.status='販売済' then
     new.sold_on:=(now() at time zone 'Asia/Tokyo')::date;
     new.sold_price:=0;new.payout_amount:=0;return new;
   elsif new.status='Amazon返送依頼' then new.return_request_completed_at:=null;return new;
   elsif new.status='検品中' then
     if new.marketplace in ('Amazon返品','動作品Amazon返品') then new.return_request_completed_at:=coalesce(new.return_request_completed_at,now());end if;
     new.inspected_at:=null;new.cleaned_at:=null;new.product_registered_at:=null;
     return new;
   elsif new.status='商品登録前' then
     new.product_registered_at:=null;new.inspected_at:=coalesce(new.inspected_at,now());
     new.malfunction_resolved_at:=case when new.malfunction_reported then coalesce(new.malfunction_resolved_at,now()) else new.malfunction_resolved_at end;
     return new;
   elsif new.status='出品中' then
     new.product_registered_at:=coalesce(new.product_registered_at,now());return new;
   elsif new.status in ('取引中','Amazon補填申請中','動作不良') then return new;
   end if;
 end if;
 -- These stages require a business decision, not a shipping/photo timestamp.
 if tg_op='UPDATE' and new.sales_channel is not distinct from old.sales_channel
 and new.status in ('取引中','Amazon補填申請中')
 and new.malfunction_reported is not distinct from old.malfunction_reported then return new;end if;
 if tg_op='UPDATE' and not explicit_change and new.status='出品中'
 and new.product_registered_at is not distinct from old.product_registered_at
 and new.sales_channel is not distinct from old.sales_channel
 and not coalesce(new.malfunction_reported and new.malfunction_resolved_at is null,false) then return new;end if;
 if new.malfunction_reported and new.malfunction_resolved_at is null then new.status:='動作不良';
 elsif new.product_registered_at is not null then new.status:='出品中';
 elsif new.inspected_at is not null or (new.malfunction_resolved_at is not null and new.sales_channel='ヤフオク') then new.status:='商品登録前';
 elsif new.marketplace in ('Amazon返品','動作品Amazon返品') then
   new.status:=case when new.return_request_completed_at is not null then '検品中'::app.item_status else 'Amazon返送依頼'::app.item_status end;
 elsif nullif(btrim(new.tracking_no),'') is not null then new.status:='検品中';
 else new.status:='受取前';end if;
 return new;
end $$;
drop trigger if exists items_sync_status on app.items;
create trigger items_sync_status before insert or update of status,tracking_no,marketplace,sales_channel,
 product_registered_at,inspected_at,cleaned_at,photo_uploaded_at,packed_on,shipped_on,listed_on,
 amazon_returned_on,sold_on,returned_on,malfunction_reported,malfunction_resolved_at,return_request_completed_at
 on app.items for each row execute function app.items_sync_status();
-- Sale-date trigger must agree with the central workflow; supplier returns have no sale date.
create or replace function app.items_mark_sold() returns trigger language plpgsql set search_path='' as $$
begin
 if new.sold_on is not null then new.status:='販売済';
 elsif new.returned_on is not null then new.status:='返品処理';end if;
 return new;
end $$;
-- Incorrect reports explicitly identified by the user. Retain the report text/history.
update app.items set malfunction_reported=false where not is_accessory and split_part(sku,'-',1) in ('2393','2397');
-- Close non-sale predecessor stages only. Real historical sale amounts are never overwritten.
update app.items i set sold_on=coalesce(i.sold_on,(now() at time zone 'Asia/Tokyo')::date),sold_price=0,payout_amount=0,status='販売済'
where not i.is_accessory and i.status<>'返品処理'
and (i.sold_on is null or (coalesce(i.sold_price,0)=0 and coalesce(i.payout_amount,0)=0))
and exists(select 1 from app.items b where not b.is_accessory and b.marketplace='動作品Amazon返品'
 and b.lot_seq=i.lot_seq and b.id<>i.id
 and (i.created_at<b.created_at or (i.created_at=b.created_at and length(split_part(i.sku,'-',1))<length(split_part(b.sku,'-',1)))));
-- Reclassify legacy active work from existing facts, not shipment dates.
update app.items set tracking_no=tracking_no where not is_accessory and status='受取前';
-- Parent changes already synchronize; repair any pre-existing accessory status differences.
update app.items a set status=p.status from app.items p where a.is_accessory and a.parent_item_id=p.id and a.status is distinct from p.status;
-- Remove the obsolete four-status whitelist without changing the view's RLS boundary.
do $$ declare d text; begin
 d:=pg_get_viewdef('app.v_delivery_tasks'::regclass,true);
 d:=regexp_replace(d,'\(i.status = ANY \(ARRAY\[[^]]+\]\)\) AND ','');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as '||d;
end $$;
-- The old task view is retained only for compatibility and no longer exposes tasks.
create or replace view app.v_delivery_return_request_tasks with(security_invoker=true) as
select t.id,t.item_id,i.sku,i.lot_seq,i.title,p.model_no,i.asin,i.deliverer_id,t.created_at,t.completed_at
from app.delivery_return_request_tasks t join app.items i on i.id=t.item_id left join app.products p on p.id=i.product_id where false;
-- Rename aggregate fields so the retired wording is absent from all current clients.
alter view app.v_stock_summary rename column "作業中" to "保有在庫";
create or replace view app.v_stock_summary as
with current_items as (
 select distinct on (app.financial_product_serial(i.sku,i.lot_seq)) i.*,
 app.financial_product_serial(i.sku,i.lot_seq) as family_key
 from app.items i where not i.is_accessory and i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良') and i.sold_on is null
 order by app.financial_product_serial(i.sku,i.lot_seq),i.purchased_at desc nulls last,i.created_at desc,i.id
)
select count(*) as "現在庫数",coalesce(sum(f.family_cost),0)::numeric as "仕入金額合計",
 coalesce(sum(coalesce(i.planned_payout,0)),0)::numeric as "売上見込み合計",
 coalesce(sum(coalesce(i.planned_payout,0)+coalesce(realized.profit,0)-f.family_cost+coalesce(realized.allocated_cost,0)),0)::numeric as "見込み利益合計",
 count(*) filter(where current_date-i.purchased_at<=7) as "高回転",
 count(*) filter(where current_date-i.purchased_at between 8 and 14) as "中回転",
 count(*) filter(where current_date-i.purchased_at>=15) as "低回転",
 count(*) as "保有在庫",
 count(*) filter(where false) as "入荷待ち"
from current_items i join app.v_financial_families f using(family_key)
left join (select family_key,sum(profit) as profit,sum(cost_amount) as allocated_cost from app.v_financial_sales group by family_key) realized using(family_key);


drop view app.v_deliverer_workload;
create view app.v_deliverer_workload with(security_invoker=true,security_barrier=true) as
with dates as(select (now() at time zone 'Asia/Tokyo')::date today,
((now() at time zone 'Asia/Tokyo')::date-interval '3 months')::date average_start)
select s.id deliverer_id,s.name deliverer_name,
count(*) filter(where not i.is_accessory and i.status in ('受取前','検品中','Amazon返送依頼','Amazon補填申請中','商品登録前','動作不良')) as "保有在庫",
avg(i.packed_on-i.purchased_at) filter(where not i.is_accessory and i.purchased_at is not null and i.packed_on between d.average_start and d.today)::numeric(10,1) as "平均作業日数"
from app.staff s join app.items i on i.deliverer_id=s.id cross join dates d
where s.is_active and (select app.management_reports_allowed()) group by s.id,s.name;
revoke all on app.v_deliverer_workload from public,anon;grant select on app.v_deliverer_workload to authenticated;
do $$ declare d text;begin
 d:=pg_get_viewdef('app.v_stock_summary'::regclass,true);
 execute 'create or replace view app.v_stock_summary with(security_invoker=true,security_barrier=true) as select report.* from ('||rtrim(btrim(d),';')||') report where (select app.management_reports_allowed())';
end $$;
-- Explicit, authorized transitions used by inventory details (not a task).
create or replace function app.set_inventory_workflow(p_item_id uuid,p_status app.item_status)
returns void language plpgsql security definer set search_path='' as $$
declare i app.items; actor uuid:=app.current_staff_id();
begin
 if auth.uid() is null or actor is null then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if not found or not coalesce(app.is_admin() or i.deliverer_id=actor or (app.current_role()='purchaser' and i.purchaser_id=actor),false) then
 raise exception 'この商品の状態を変更できません' using errcode='42501';end if;
 if i.is_accessory and i.parent_item_id is not null then raise exception '本体から変更してください' using errcode='22023';end if;
 if i.sold_on is not null and p_status<>'販売済' then raise exception '販売日がある商品は販売済です' using errcode='22023';end if;
 if p_status='販売済' then
   if i.sold_on is not null then return;end if;
   update app.items set sold_on=(now() at time zone 'Asia/Tokyo')::date,sold_price=0,payout_amount=0,status='販売済' where id=i.id;
 else
   update app.items set status=p_status where id=i.id;
 end if;
end $$;
revoke all on function app.set_inventory_workflow(uuid,app.item_status) from public,anon;
grant execute on function app.set_inventory_workflow(uuid,app.item_status) to authenticated;
-- A mistaken malfunction report can be returned to the appropriate inspection stage.
create or replace function app.resolve_item_malfunction(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=app.current_staff_id();begin
 if auth.uid() is null or not coalesce(app.is_admin() or (app.current_role()='purchaser' and exists(select 1 from app.items where id=p_item_id and purchaser_id=actor)),false) then
 raise exception '対象商品の仕入担当者または管理者のみ差し戻しできます' using errcode='42501';end if;
 update app.items set malfunction_reported=false,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor
 where id=p_item_id and malfunction_reported and malfunction_resolved_at is null;
 if not found then raise exception '未対応の動作不良報告が見つかりません' using errcode='P0002';end if;
end $$;
-- Authenticated extension snapshots are exact-serial and sales-channel scoped.
create or replace function app.sync_marketplace_sale_status(p_channel text,p_serial text,p_status text,p_observed_at timestamptz)
returns text language plpgsql security definer set search_path='' as $$
declare i app.items;actor uuid:=app.current_staff_id();n integer;
begin
 if auth.uid() is null or not coalesce(app.current_role() in ('admin','purchaser'),false) then raise exception '権限がありません' using errcode='42501';end if;
 if p_channel not in ('メルカリ','ヤフオク') or p_status not in ('出品中','取引中')
 or p_serial !~ '^[0-9]+[a-z]*$' or p_observed_at is null or p_observed_at>now()+interval '5 minutes' or p_observed_at<now()-interval '1 day' then
 raise exception '取得情報を確認してください' using errcode='22023';end if;
 select count(*) into n from app.items where not is_accessory and split_part(sku,'-',1)=p_serial and sales_channel::text=p_channel
 and (app.is_admin() or purchaser_id=actor);
 if n<>1 then return 'unmatched';end if;
 select * into i from app.items where not is_accessory and split_part(sku,'-',1)=p_serial and sales_channel::text=p_channel
 and (app.is_admin() or purchaser_id=actor) for update;
 if i.sold_on is not null or i.status in ('販売済','返品処理','Amazon補填申請中','動作不良') then return 'protected';end if;
 if i.marketplace_status_observed_at is not null and i.marketplace_status_observed_at>=p_observed_at then return 'stale';end if;
 update app.items set status=p_status::app.item_status,marketplace_status_observed_at=p_observed_at where id=i.id;
 return 'updated';
end $$;
revoke all on function app.sync_marketplace_sale_status(text,text,text,timestamptz) from public,anon;
grant execute on function app.sync_marketplace_sale_status(text,text,text,timestamptz) to authenticated;
notify pgrst,'reload schema';
