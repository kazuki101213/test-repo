-- State-specific commands are the delivery write boundary. Every transition is locked,
-- checks its source status and actor, and keeps an immutable local action history.
alter table app.items add column if not exists supplier_contact_requested_at timestamptz;
alter table app.items add column if not exists workflow_decision text;
alter table app.items add column if not exists workflow_previous_sales_channel app.sales_channel;
alter table app.items add column if not exists seller_trade_key text;
alter table app.items add column if not exists seller_cancelled_trade_key text;
alter table app.items add column if not exists seller_cancelled_at timestamptz;
alter table app.items add column if not exists seller_message_attention boolean not null default false;
create table app.inventory_workflow_events(
 id uuid primary key, item_id uuid not null references app.items(id) on delete cascade, actor_id uuid not null references app.staff(id),
 action text not null, from_status app.item_status not null,to_status app.item_status not null,
 note text, created_at timestamptz not null default clock_timestamp()
);
create index inventory_workflow_events_item_time on app.inventory_workflow_events(item_id,created_at desc);
alter table app.inventory_workflow_events enable row level security;
revoke all on app.inventory_workflow_events from public,anon,authenticated;
grant select on app.inventory_workflow_events to authenticated;
create policy inventory_workflow_events_read on app.inventory_workflow_events for select to authenticated using(exists(
 select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))));

create or replace function app.perform_inventory_action(p_item_id uuid,p_action text,p_expected_status app.item_status,p_note text default null,p_request_id uuid default gen_random_uuid())
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;actor uuid:=app.current_staff_id();manager boolean;target app.item_status;old_event app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 manager:=coalesce(app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=actor),false);
 if i.id is null or not coalesce(manager or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から操作してください' using errcode='22023';end if;
 if p_request_id is null then raise exception '操作IDがありません' using errcode='22023';end if;
 select * into old_event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if old_event.item_id=i.id and old_event.actor_id=actor and old_event.action=p_action and old_event.note is not distinct from nullif(btrim(p_note),'') then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';
 end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('running','uncertain')) or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('running','uncertain')) then raise exception '実行中の操作の結果を確認してから状態を変更してください';end if;
 if i.sold_on is not null or i.status='販売済' then raise exception '販売済の商品は管理機能で販売日を訂正してください' using errcode='22023';end if;
 if i.status is distinct from p_expected_status then raise exception '状態が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 if length(coalesce(p_note,''))>2000 then raise exception '2000文字以内で入力してください' using errcode='22023';end if;
 target:=i.status;
 case p_action
 when 'return_request_complete' then
  if i.status<>'Amazon返送依頼' or i.marketplace not in ('Amazon返品','動作品Amazon返品') then raise exception '返送依頼待ちの商品ではありません';end if;
  target:='検品中';update app.items set return_request_completed_at=clock_timestamp(),status=target where id=i.id;
 when 'return_request_cancel' then
  if i.status<>'検品中' or i.marketplace not in ('Amazon返品','動作品Amazon返品') then raise exception '返送依頼の取消対象ではありません';end if;
  target:='Amazon返送依頼';update app.items set return_request_completed_at=null,status=target where id=i.id;
 when 'inspection_complete' then
  if i.status<>'検品中' then raise exception '検品中の商品ではありません';end if;
  target:='商品登録前';update app.items set inspected_at=coalesce(inspected_at,clock_timestamp()),cleaned_at=coalesce(cleaned_at,clock_timestamp()),status=target where id=i.id;
 when 'inspection_cancel' then
  if i.status<>'商品登録前' or i.workflow_decision is not null then raise exception '検品完了の取消対象ではありません';end if;
  target:='検品中';update app.items set inspected_at=null,cleaned_at=null,product_registered_at=null,status=target where id=i.id;
 when 'report' then
  if i.status<>'検品中' or nullif(btrim(p_note),'') is null then raise exception '検品中の商品について報告内容を入力してください';end if;
  target:=case when i.marketplace in ('Amazon返品','動作品Amazon返品') then 'Amazon補填申請中'::app.item_status else '動作不良'::app.item_status end;
  update app.items set malfunction_reported=true,malfunction_comment=btrim(p_note),malfunction_reported_at=clock_timestamp(),malfunction_reported_by=actor,malfunction_resolved_at=null,malfunction_resolved_by=null,status=target where id=i.id;
 when 'report_cancel','send_back' then
  if i.status not in ('動作不良','Amazon補填申請中') then raise exception '報告の取消対象ではありません';end if;
  if p_action='send_back' and not manager then raise exception '管理者・仕入担当者のみ差し戻しできます' using errcode='42501';end if;
  if i.status='Amazon補填申請中' and not manager then raise exception '破損報告の差し戻しは管理側から行ってください' using errcode='42501';end if;
  target:='検品中';update app.items set malfunction_reported=false,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,supplier_contact_requested_at=null,workflow_decision=null,status=target where id=i.id;
 when 'supplier_check' then
  if not manager then raise exception '管理者・仕入担当者のみ操作できます' using errcode='42501';end if;
  if i.status<>'動作不良' then raise exception '動作不良の商品ではありません';end if;
  update app.items set supplier_contact_requested_at=clock_timestamp() where id=i.id;
  insert into app.item_comments(item_id,author_id,body,task_kind) values(i.id,actor,'仕入先へ確認します。','仕入先確認');
 when 'supplier_return_complete' then
  if i.status<>'動作不良' or i.supplier_contact_requested_at is null then raise exception '仕入先確認後に返品完了を登録してください';end if;
  target:='返品処理';update app.items set returned_on=(clock_timestamp() at time zone 'Asia/Tokyo')::date,status=target where id=i.id;
 when 'supplier_return_cancel' then
  if i.status<>'返品処理' or i.marketplace in ('Amazon返品','動作品Amazon返品') then raise exception '返品完了の取消対象ではありません';end if;
  target:='動作不良';update app.items set returned_on=null,malfunction_reported=true,malfunction_resolved_at=null,status=target where id=i.id;
 when 'return_impossible','yahoo_instruction' then
  if i.status<>'動作不良' or (p_action='return_impossible' and i.supplier_contact_requested_at is null) then raise exception '動作不良の商品で仕入先確認後に操作してください';end if;
  if p_action='yahoo_instruction' and not manager then raise exception '販売指示は管理側から行ってください' using errcode='42501';end if;
  target:='商品登録前';update app.items set workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status=target where id=i.id;
 when 'yahoo_instruction_cancel' then
  if i.status<>'商品登録前' or i.workflow_decision is distinct from 'yahoo' then raise exception '返品不可・販売指示の取消対象ではありません';end if;
  target:='動作不良';update app.items set sales_channel=coalesce(workflow_previous_sales_channel,sales_channel),workflow_decision=null,malfunction_reported=true,malfunction_resolved_at=null,status=target where id=i.id;
 when 'compensation_complete','compensation_denied' then
  if not manager then raise exception '補填結果は管理側から登録してください' using errcode='42501';end if;
  if i.status<>'Amazon補填申請中' then raise exception 'Amazon補填申請中の商品ではありません';end if;
  target:='商品登録前';update app.items set sales_channel='ヤフオク',workflow_decision=case when p_action='compensation_complete' then 'compensated' else 'compensation_denied' end,malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status=target where id=i.id;
 when 'listing_complete' then
  if i.status<>'商品登録前' or i.sales_channel not in ('FBA','自己発送') then raise exception 'FBA・自己発送の出品完了のみ手動で登録できます';end if;
  target:='出品中';update app.items set product_registered_at=clock_timestamp(),status=target where id=i.id;
 when 'listing_cancel' then
  if i.status<>'出品中' or nullif(btrim(p_note),'') is null then raise exception '実際に出品されていないことを確認してください';end if;
  target:='商品登録前';update app.items set product_registered_at=null,status=target,seller_cancelled_trade_key=coalesce(seller_trade_key,'*'),seller_cancelled_at=clock_timestamp() where id=i.id;
 when 'trade_cancel','resell' then
  if i.status<>'取引中' or nullif(btrim(p_note),'') is null then raise exception '取引中の商品について理由を入力してください';end if;
  target:=case when p_action='trade_cancel' then '出品中'::app.item_status else '商品登録前'::app.item_status end;
  update app.items set status=target,product_registered_at=case when p_action='resell' then null else product_registered_at end,seller_cancelled_trade_key=coalesce(seller_trade_key,'*'),seller_cancelled_at=clock_timestamp() where id=i.id;
 else raise exception '未対応の操作です' using errcode='22023';
 end case;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note) values(p_request_id,i.id,actor,p_action,i.status,target,nullif(btrim(p_note),''));
end $$;
revoke all on function app.perform_inventory_action(uuid,text,app.item_status,text,uuid) from public,anon;
grant execute on function app.perform_inventory_action(uuid,text,app.item_status,text,uuid) to authenticated;

-- Existing entry points share the same transition checks.
create or replace function app.report_item_malfunction(p_item_id uuid,p_comment text) returns void language plpgsql security invoker set search_path=pg_catalog,app as $$
begin perform app.perform_inventory_action(p_item_id,'report','検品中',p_comment);end $$;
create or replace function app.resolve_item_malfunction(p_item_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare state app.item_status;begin
 select status into state from app.items where id=p_item_id;
 perform app.perform_inventory_action(p_item_id,'send_back',state);
end $$;
-- Reuse existing supplier/Yahoo reply templates without moving or duplicating accessories.
create or replace function app.apply_malfunction_reply() returns trigger language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 if new.task_kind='仕入先確認' then update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  update app.items set workflow_previous_sales_channel=sales_channel,workflow_decision='yahoo',sales_channel='ヤフオク',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前' where id=new.item_id;
 end if;return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;

-- Include small workflow flags in both full detail and incremental list reads.
do $$declare definition text;begin
 definition:=regexp_replace(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),';\s*$','');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as select v.*,i.return_request_completed_at,i.supplier_contact_requested_at,i.workflow_decision,i.seller_message_attention from ('||definition||') v join app.items i on i.id=v.id';
end $$;
notify pgrst,'reload schema';

-- Preserve conditional snapshots while exposing the current report phase to management.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'i.malfunction_reported_by,','i.malfunction_reported_by,i.status,');
 definition:=replace(definition,'where i.malfunction_reported and i.malfunction_resolved_at is null','where i.malfunction_reported and i.malfunction_resolved_at is null and i.status in (''動作不良'',''Amazon補填申請中'') and i.sold_on is null');
 execute definition;
end $$;
-- A delivery caller cannot bypass the flow through the previous general status API.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.set_inventory_workflow(uuid,app.item_status)'::regprocedure);
 definition:=replace(definition,'or i.deliverer_id=actor','');
 execute definition;
 definition:=pg_get_functiondef('app.sync_marketplace_sale_status(text,text,text,timestamptz)'::regprocedure);
 definition:=replace(definition,'if i.marketplace_status_observed_at is not null','if i.seller_cancelled_at is not null then return ''protected'';end if; if i.marketplace_status_observed_at is not null');
 execute definition;
end $$;
-- Seller records attach to an existing physical inventory row. A scrape never inserts inventory.
create table app.seller_listings(
 id uuid primary key default gen_random_uuid(),item_id uuid not null references app.items(id) on delete cascade,
 channel app.sales_channel not null check(channel in ('メルカリ','ヤフオク')),account_id text not null check(account_id in ('mercari-1','auctions-1')),
 external_id text not null,url text not null,trade_url text,trade_key text,observed_at timestamptz,active boolean not null default true,
 unique(channel,account_id,external_id)
);
create unique index seller_current_item on app.seller_listings(item_id) where active;
create table app.seller_operations(
 id uuid primary key,item_id uuid not null references app.items(id) on delete cascade,actor_id uuid not null references app.staff(id),
 kind text not null check(kind in ('listing','shipping_code','register_package','verify_shipping','ship_notice','message_sync','message_send')),
 channel app.sales_channel not null,account_id text not null,expected_status app.item_status not null,expected_updated_at timestamptz not null,payload jsonb not null,
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','uncertain')),
 result jsonb not null default '{}',created_at timestamptz not null default clock_timestamp(),claimed_at timestamptz,finished_at timestamptz
);
create unique index seller_one_pending on app.seller_operations(item_id) where status in ('queued','running','uncertain');
create index seller_queue on app.seller_operations(account_id,created_at) where status='queued';
alter table app.seller_listings enable row level security;
alter table app.seller_operations enable row level security;
revoke all on app.seller_listings,app.seller_operations from public,anon,authenticated;
grant select on app.seller_listings,app.seller_operations to authenticated;
create policy seller_listing_read on app.seller_listings for select to authenticated using(exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))));
create policy seller_operation_read on app.seller_operations for select to authenticated using(exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))));
create function app.seller_operation_context(p_item_id uuid) returns jsonb language sql stable security invoker set search_path=pg_catalog,app as $$
 select jsonb_build_object('listing',(select to_jsonb(l) from app.seller_listings l where l.item_id=i.id and l.active),'assignee',(select name from app.staff where id=i.deliverer_id),
 'revision',i.updated_at,'operations',coalesce((select jsonb_agg((to_jsonb(q)-'payload')||jsonb_build_object('trade_key',q.payload->>'trade_key','result',case when q.status='succeeded' and q.id=(select o.id from app.seller_operations o where o.item_id=i.id and o.kind=q.kind and o.status='succeeded' order by o.created_at desc limit 1) then q.result else jsonb_build_object('note',q.result->>'note') end) order by q.created_at desc) from (select * from app.seller_operations where item_id=i.id order by created_at desc limit 12) q),'[]'::jsonb)) from app.items i where i.id=p_item_id
$$;
revoke all on function app.seller_operation_context(uuid) from public,anon;
grant execute on function app.seller_operation_context(uuid) to authenticated;
create function app.queue_seller_operation(p_item_id uuid,p_kind text,p_payload jsonb,p_request_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;a uuid:=app.current_staff_id();existing app.seller_operations;link app.seller_listings;proof app.seller_operations;
begin
 if auth.uid() is null or a is null or not exists(select 1 from app.staff where id=a and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=a,false) then raise exception '納品担当者または管理者のみ操作できます' using errcode='42501';end if;
 select * into existing from app.seller_operations where id=p_request_id;
 if found then if existing.item_id=i.id and existing.actor_id=a and existing.kind=p_kind and existing.payload=p_payload then return existing.id;end if;raise exception '操作IDが重複しています';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から操作してください';end if;
 if i.sold_on is not null or i.status='販売済' then raise exception '販売済の商品は操作できません';end if;
 if i.sales_channel not in ('メルカリ','ヤフオク') or i.sales_channel is null then raise exception '販売先が対応していません';end if;
 if nullif(p_payload->>'expected_revision','')::timestamptz is distinct from i.updated_at then raise exception '商品が更新されています。内容を確認してから操作してください';end if;
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>200000 then raise exception '入力内容を確認してください';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '前の操作の結果確認が必要です。二重実行を防ぐため停止しました';end if;
 select * into link from app.seller_listings where item_id=i.id and active;
 if p_kind='listing' then
  if i.status<>'商品登録前' then raise exception '商品登録前の商品だけ出品できます';end if;
  if length(btrim(coalesce(p_payload->>'title',''))) not between 1 and 128 or length(btrim(coalesce(p_payload->>'description',''))) not between 1 and 5000
  or coalesce(p_payload->>'price','')!~'^[0-9]{1,9}$' or (p_payload->>'price')::numeric<1
  or nullif(p_payload->>'condition','') is null or nullif(p_payload->>'origin','') is null or nullif(p_payload->>'shippingMethod','') is null
  or jsonb_typeof(p_payload->'photos') is distinct from 'array' then raise exception '出品内容を確認してください';end if;
  if jsonb_array_length(p_payload->'photos') not between 1 and 10 or exists(select 1 from jsonb_array_elements_text(p_payload->'photos') u where u!~'^https://(xgoppuqoqeppckyunnvx[.]supabase[.]co/|lh3[.]googleusercontent[.]com/|drive[.]google[.]com/|drive[.]usercontent[.]google[.]com/|drive[.]googleusercontent[.]com/)') then raise exception '商品写真を確認してください';end if;
 elsif p_kind in ('shipping_code','register_package','verify_shipping','ship_notice','message_sync','message_send') then
  if (i.status<>'取引中' and not (p_kind in ('message_sync','message_send') and i.status='出品中' and i.seller_message_attention)) or link.id is null or link.trade_key is null then raise exception '対象の取引情報を先に取得してください';end if;
  if p_payload->>'trade_key' is distinct from link.trade_key then raise exception '取引情報が更新されています';end if;
  if p_kind='register_package' and length(btrim(coalesce(p_payload->>'code',''))) not between 1 and 2048 then raise exception '専用資材のコードを読み取ってください';end if;
  if p_kind='message_send' and length(btrim(coalesce(p_payload->>'body',''))) not between 1 and 2000 then raise exception 'メッセージを入力してください';end if;
  if p_kind='ship_notice' then
   select * into proof from app.seller_operations where id=(p_payload->>'proof_id')::uuid and item_id=i.id and status='succeeded' and payload->>'trade_key'=link.trade_key;
   if proof.id is null or not ((proof.kind='register_package' and (p_payload->>'posted')::boolean is true) or (proof.kind='verify_shipping' and (proof.result->>'accepted')::boolean is true)) then raise exception 'コード登録後の投函、または店舗での受付を確認してください';end if;
  end if;
 else raise exception '未対応の操作です';end if;
 insert into app.seller_operations(id,item_id,actor_id,kind,channel,account_id,expected_status,expected_updated_at,payload)
 values(p_request_id,i.id,a,p_kind,i.sales_channel,case when i.sales_channel='メルカリ' then 'mercari-1' else 'auctions-1' end,i.status,i.updated_at,p_payload);
 return p_request_id;
end $$;
revoke all on function app.queue_seller_operation(uuid,text,jsonb,uuid) from public,anon;
grant execute on function app.queue_seller_operation(uuid,text,jsonb,uuid) to authenticated;
create function app.extension_seller_queue(p_account_ids text[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (select o.*,l.external_id,coalesce(l.trade_url,l.url) url,l.trade_key from app.seller_operations o left join app.seller_listings l on l.item_id=o.item_id and l.active where o.status='queued' and o.account_id=any(p_account_ids) order by o.created_at limit 10) q),'[]'::jsonb);
end $$;
create function app.extension_claim_seller_operation(p_id uuid,p_account_id text) returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 update app.seller_operations set status='running',claimed_at=clock_timestamp() where id=p_id and status='queued' and account_id=p_account_id and exists(select 1 from app.items i where i.id=app.seller_operations.item_id and i.status=app.seller_operations.expected_status and i.updated_at=app.seller_operations.expected_updated_at and i.sold_on is null and i.sales_channel=app.seller_operations.channel and (app.seller_operations.kind='listing' or exists(select 1 from app.seller_listings l where l.item_id=i.id and l.active and l.trade_key=app.seller_operations.payload->>'trade_key')));
 if found then return true;end if;
 update app.seller_operations set status='failed',finished_at=clock_timestamp(),result=jsonb_build_object('note','商品または取引が変更されたため実行しませんでした') where id=p_id and account_id=p_account_id and status='queued';return false;
end $$;
create function app.extension_finish_seller_operation(p_id uuid,p_status text,p_result jsonb) returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;ext text;u text;begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_status not in ('succeeded','failed','uncertain') or p_result is null or octet_length(p_result::text)>200000 then raise exception '結果を確認してください';end if;
 select * into q from app.seller_operations where id=p_id for update;
 if q.id is null then raise exception '操作がありません';end if;
 if q.status=p_status and q.result=p_result then return;end if;
 if q.status<>'running' then raise exception '実行済みの操作です';end if;
 select * into i from app.items where id=q.item_id for update;
 if p_status='succeeded' and q.kind='listing' then
  ext:=p_result->>'external_id';u:=p_result->>'url';
  if not ((q.channel='メルカリ' and ext~'^m[0-9]+$' and u='https://jp.mercari.com/item/'||ext) or (q.channel='ヤフオク' and ext~'^[a-z][0-9]+$' and u='https://page.auctions.yahoo.co.jp/jp/auction/'||ext)) then raise exception '出品結果のURL・商品IDを確認してください';end if;
  update app.seller_listings set active=false where item_id=i.id and active;
  insert into app.seller_listings(item_id,channel,account_id,external_id,url) values(i.id,q.channel,q.account_id,ext,u)
  on conflict(channel,account_id,external_id) do update set active=true where app.seller_listings.item_id=excluded.item_id;
  if not found then raise exception '他の商品と出品IDが重複しています';end if;
  if i.status=q.expected_status and i.sold_on is null and i.sales_channel=q.channel then
   update app.items set status='出品中',product_registered_at=clock_timestamp(),seller_trade_key=null,seller_cancelled_at=null,seller_cancelled_trade_key=null where id=i.id;
  else p_status:='uncertain';p_result:=p_result||jsonb_build_object('note','出品後に商品の状態が変わっています。出品URLを確認してください');end if;
 elsif p_status='succeeded' and q.kind='message_sync' then
  update app.items set seller_message_attention=coalesce((p_result->>'attention')::boolean,false) where id=i.id;
 end if;
 update app.seller_operations set status=p_status,result=p_result,finished_at=clock_timestamp() where id=q.id;
end $$;
revoke all on function app.extension_seller_queue(text[]),app.extension_claim_seller_operation(uuid,text),app.extension_finish_seller_operation(uuid,text,jsonb) from public,anon;
grant execute on function app.extension_seller_queue(text[]),app.extension_claim_seller_operation(uuid,text),app.extension_finish_seller_operation(uuid,text,jsonb) to authenticated;

-- Exact listing identity takes priority; legacy serial matching requires one exact row.
create function app.sync_seller_observation(p_account_id text,p_observation jsonb) returns text language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;l app.seller_listings;ch app.sales_channel;ext text:=p_observation->>'external_id';serial text:=lower(p_observation->>'serial');
 observed timestamptz:=(p_observation->>'observed_at')::timestamptz;state text:=p_observation->>'status';trade text:=p_observation->>'trade_key';n integer;day date;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 ch:=case p_account_id when 'mercari-1' then 'メルカリ'::app.sales_channel when 'auctions-1' then 'ヤフオク'::app.sales_channel else null end;
 if nullif(p_observation->>'trade_url','') is not null and (p_observation->>'trade_url')!~'^https://(jp[.]mercari[.]com/transaction/|contact[.]auctions[.]yahoo[.]co[.]jp/|buy[.]auctions[.]yahoo[.]co[.]jp/|aucpay[.]yahoo[.]co[.]jp/|salesmanagement[.]yahoo[.]co[.]jp/)' then raise exception '取引URLを確認してください';end if;
 if ch is null or observed is null or observed>clock_timestamp()+interval '5 minutes' or observed<clock_timestamp()-interval '1 day' or state not in ('出品中','支払い待ち','取引中','販売済','キャンセル')
 or not ((ch='メルカリ' and ext~'^m[0-9]+$') or (ch='ヤフオク' and ext~'^[a-z][0-9]+$')) then raise exception '取得情報を確認してください';end if;
 select * into l from app.seller_listings where channel=ch and account_id=p_account_id and external_id=ext;
 if l.id is not null then
  if not l.active then return 'protected';end if;
  select * into i from app.items where id=l.item_id for update;
 else
  if serial is null or serial!~'^[0-9]+[a-z]*$' then return 'unmatched';end if;
  select count(*) into n from app.items where split_part(sku,'-',1)=serial and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq)) and sales_channel=ch;
  if n<>1 then return 'unmatched';end if;
  select * into i from app.items where split_part(sku,'-',1)=serial and (not is_accessory or app.is_standalone_accessory_serial(sku,lot_seq)) and sales_channel=ch for update;
  if exists(select 1 from app.seller_listings where item_id=i.id and active) then return 'unmatched';end if;
  insert into app.seller_listings(item_id,channel,account_id,external_id,url) values(i.id,ch,p_account_id,ext,case when ch='メルカリ' then 'https://jp.mercari.com/item/'||ext else 'https://page.auctions.yahoo.co.jp/jp/auction/'||ext end) returning * into l;
 end if;
 if i.sold_on is not null or i.status in ('販売済','返品処理','動作不良','Amazon補填申請中') or i.sales_channel<>ch then return 'protected';end if;
 if greatest(l.observed_at,i.marketplace_status_observed_at)>=observed then return 'stale';end if;
 if i.seller_cancelled_at is not null and (i.seller_cancelled_trade_key='*' or trade is null or trade=i.seller_cancelled_trade_key or trade=ext or state not in ('取引中','販売済')) then return 'protected';end if;
 if state='販売済' then
  day:=(p_observation->>'sold_on')::date;
  if day is null or day>(clock_timestamp() at time zone 'Asia/Tokyo')::date or day<i.purchased_at or coalesce(p_observation->>'sold_price','')!~'^[0-9]{1,9}$' or coalesce(p_observation->>'payout_amount','')!~'^[0-9]{1,9}$' then raise exception '実際の販売日・販売金額・振込金額を確認できません';end if;
  if l.trade_key is not null and l.trade_key<>l.external_id and trade is distinct from l.trade_key then return 'unmatched';end if;
  update app.items set sold_on=day,sold_price=(p_observation->>'sold_price')::numeric,payout_amount=(p_observation->>'payout_amount')::numeric,status='販売済',seller_trade_key=trade,marketplace_status_observed_at=observed where id=i.id;
 elsif state='キャンセル' then
  if i.status<>'取引中' or trade is distinct from l.trade_key then return 'protected';end if;
  update app.items set status='出品中',seller_cancelled_trade_key=coalesce(trade,'*'),seller_cancelled_at=observed,marketplace_status_observed_at=observed where id=i.id;
 else
  if i.status not in ('商品登録前','出品中','取引中') then return 'protected';end if;
  if state in ('取引中','支払い待ち') and trade is null then raise exception '取引IDを確認してください';end if;
  if i.status='取引中' and state in ('出品中','支払い待ち') then return 'protected';end if;
  update app.items set status=case when state='支払い待ち' then '出品中'::app.item_status else state::app.item_status end,
   seller_trade_key=coalesce(trade,seller_trade_key),seller_cancelled_at=case when trade is not null and trade is distinct from seller_cancelled_trade_key then null else seller_cancelled_at end,marketplace_status_observed_at=observed,
   seller_message_attention=coalesce((p_observation->>'attention')::boolean,false) where id=i.id;
 end if;
 update app.seller_listings set observed_at=observed,trade_key=coalesce(trade,trade_key),trade_url=coalesce(p_observation->>'trade_url',trade_url) where id=l.id;
 return 'updated';
end $$;
revoke all on function app.sync_seller_observation(text,jsonb) from public,anon;
grant execute on function app.sync_seller_observation(text,jsonb) to authenticated;
notify pgrst,'reload schema';
-- All seven existing purchase/tracking accounts finish before seller reads begin.
create table app.seller_daily_barriers(day date not null,profile_id uuid not null,account_ids text[] not null,finished_at timestamptz not null default clock_timestamp(),primary key(day,profile_id));
alter table app.seller_daily_barriers enable row level security;
revoke all on app.seller_daily_barriers from public,anon,authenticated;
create function app.extension_seller_daily_barrier(p_day date,p_profile_id uuid,p_account_ids text[]) returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if p_day is distinct from (clock_timestamp() at time zone 'Asia/Tokyo')::date or p_profile_id is null or cardinality(p_account_ids) not between 1 and 7 or exists(select 1 from unnest(p_account_ids) a where a is null or a not in ('mercari-1','mercari-2','auctions-1','auctions-2','flea-1','flea-2','rakuma-1')) then raise exception '完了情報を確認してください';end if;
 insert into app.seller_daily_barriers(day,profile_id,account_ids) values(p_day,p_profile_id,p_account_ids) on conflict(day,profile_id) do update set account_ids=excluded.account_ids;
 delete from app.seller_daily_barriers where day<p_day-14;
 return (select count(distinct a)=7 from app.seller_daily_barriers b cross join lateral unnest(b.account_ids) a where b.day=p_day);
end $$;
create function app.seller_sync_context(p_account_ids text[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('item_id',i.id,'serial',split_part(i.sku,'-',1),'external_id',l.external_id,'account_id',case when i.sales_channel='メルカリ' then 'mercari-1' else 'auctions-1' end)) from app.items i left join app.seller_listings l on l.item_id=i.id and l.active where (not i.is_accessory or app.is_standalone_accessory_serial(i.sku,i.lot_seq)) and i.sold_on is null and i.status in ('商品登録前','出品中','取引中') and (case when i.sales_channel='メルカリ' then 'mercari-1' when i.sales_channel='ヤフオク' then 'auctions-1' end)=any(p_account_ids)),'[]'::jsonb);
end $$;
revoke all on function app.extension_seller_daily_barrier(date,uuid,text[]),app.seller_sync_context(text[]) from public,anon;
grant execute on function app.extension_seller_daily_barrier(date,uuid,text[]),app.seller_sync_context(text[]) to authenticated;
-- Supplier conversations remain available throughout the fault/return decision.
create table app.supplier_operations(
 id uuid primary key,item_id uuid not null references app.items(id) on delete cascade,actor_id uuid not null references app.staff(id),
 account_id text not null,marketplace text not null,external_id text not null,contact_requested_at timestamptz not null,kind text not null check(kind in ('read','send')),body text,
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','uncertain')),
 created_at timestamptz not null default clock_timestamp(),claimed_at timestamptz,finished_at timestamptz,note text
);
create unique index supplier_pending_item on app.supplier_operations(item_id) where status in ('queued','running','uncertain');
alter table app.supplier_operations enable row level security;
revoke all on app.supplier_operations from public,anon,authenticated;
create function app.supplier_conversation(p_item_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare i app.items;account text;begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()),false) then raise exception '権限がありません' using errcode='42501';end if;
 select case when count(distinct account_label)=1 then min(account_label) else null end into account from app.marketplace_purchase_drafts d where d.marketplace=i.marketplace::text and d.marketplace_item_id=i.marketplace_item_id;
 return jsonb_build_object('account_id',case account when 'メルカリ1' then 'mercari-1' when 'メルカリ2' then 'mercari-2' when 'ヤフオク1' then 'auctions-1' when 'ヤフオク2' then 'auctions-2' when 'Yahoo!フリマ1' then 'flea-1' when 'Yahoo!フリマ2' then 'flea-2' when 'ラクマ1' then 'rakuma-1' end,
 'messages',coalesce((select jsonb_agg(to_jsonb(m) order by m.sent_at,m.synced_at) from (select id,author,author_role,body,sent_at,synced_at from app.marketplace_messages where item_id=i.id order by coalesce(sent_at,synced_at) desc limit 100) m),'[]'::jsonb),
 'outbox',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'body',q.body,'status',case q.status when 'running' then 'sending' when 'succeeded' then 'sent' else q.status end,'sent_at',q.finished_at,'result_note',q.note) order by q.created_at) from app.supplier_operations q where q.item_id=i.id and q.kind='send' and q.status<>'succeeded'),'[]'::jsonb),
 'sync',(select jsonb_build_object('id',q.id,'status',case q.status when 'succeeded' then 'completed' when 'running' then 'processing' else q.status end,'result_note',q.note) from app.supplier_operations q where q.item_id=i.id and q.kind='read' order by q.created_at desc limit 1),'expired',false);
end $$;
create function app.queue_supplier_operation(p_item_id uuid,p_kind text,p_body text,p_account_id text,p_request_id uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;q app.supplier_operations;a uuid:=app.current_staff_id();expected text;begin
 select * into i from app.items where id=p_item_id for update;
 if auth.uid() is null or a is null or not exists(select 1 from app.staff where id=a and is_active) or not coalesce(app.is_admin() or i.deliverer_id=a or (app.current_role()='purchaser' and i.purchaser_id=a),false) then raise exception '権限がありません' using errcode='42501';end if;
 if i.status<>'動作不良' or i.supplier_contact_requested_at is null or i.sold_on is not null then raise exception '仕入先確認が必要な動作不良商品から操作してください';end if;
 expected:=case when p_account_id in ('mercari-1','mercari-2') then 'メルカリ' when p_account_id in ('auctions-1','auctions-2') then 'ヤフオク' when p_account_id in ('flea-1','flea-2') then 'ヤフフリ' when p_account_id='rakuma-1' then 'ラクマ' end;
 if expected is null or not (i.marketplace::text=expected or (expected='ヤフフリ' and i.marketplace::text='PayPayフリマ')) or nullif(i.marketplace_item_id,'') is null then raise exception '購入したアカウントを選択してください';end if;
 select * into q from app.supplier_operations where id=p_request_id;
 if found then if q.item_id=i.id and q.actor_id=a and q.kind=p_kind and q.body is not distinct from p_body and q.account_id=p_account_id then return q.id;end if;raise exception '操作IDが重複しています';end if;
 if p_kind not in ('read','send') or p_request_id is null or (p_kind='send' and length(btrim(coalesce(p_body,''))) not between 1 and 2000) then raise exception '入力を確認してください';end if;
 if exists(select 1 from app.supplier_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '前の操作の結果を確認するまで再送できません';end if;
 insert into app.supplier_operations(id,item_id,actor_id,account_id,marketplace,external_id,contact_requested_at,kind,body) values(p_request_id,i.id,a,p_account_id,i.marketplace::text,i.marketplace_item_id,i.supplier_contact_requested_at,p_kind,p_body);return p_request_id;
end $$;
create function app.extension_supplier_queue(p_account_ids text[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (select o.* from app.supplier_operations o join app.items i on i.id=o.item_id where o.status='queued' and o.account_id=any(p_account_ids) and i.status='動作不良' and i.supplier_contact_requested_at is not null order by o.created_at limit 10) q),'[]'::jsonb);
end $$;
create function app.extension_claim_supplier_operation(p_id uuid,p_account_id text) returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
begin if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 update app.supplier_operations set status='running',claimed_at=clock_timestamp() where id=p_id and account_id=p_account_id and status='queued' and exists(select 1 from app.items i where i.id=app.supplier_operations.item_id and i.status='動作不良' and i.supplier_contact_requested_at=app.supplier_operations.contact_requested_at and i.sold_on is null and i.marketplace_item_id=app.supplier_operations.external_id);
 if found then return true;end if;update app.supplier_operations set status='failed',finished_at=clock_timestamp(),note='商品の状態が変更されたため実行しませんでした' where id=p_id and account_id=p_account_id and status='queued';return false;
end $$;
create function app.extension_finish_supplier_operation(p_id uuid,p_status text,p_messages jsonb,p_note text) returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare q app.supplier_operations;begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 select * into q from app.supplier_operations where id=p_id for update;
 if q.id is null or q.status<>'running' or p_status not in ('succeeded','failed','uncertain') then raise exception '結果を確認してください';end if;
 if jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages)>500 or octet_length(p_messages::text)>2000000 then raise exception '会話の量を確認してください';end if;
 insert into app.marketplace_messages(marketplace,marketplace_item_id,item_id,external_id,author,author_role,body,sent_at)
 select q.marketplace,q.external_id,q.item_id,left(m->>'external_id',200),left(m->>'author',200),case when m->>'author_role' in ('self','other') then m->>'author_role' else 'unknown' end,left(m->>'body',10000),nullif(m->>'sent_at','')::timestamptz from jsonb_array_elements(p_messages) m where nullif(m->>'external_id','') is not null and nullif(m->>'body','') is not null
 on conflict(marketplace,marketplace_item_id,external_id) do update set body=excluded.body,author=excluded.author,sent_at=excluded.sent_at,synced_at=clock_timestamp();
 update app.supplier_operations set status=p_status,finished_at=clock_timestamp(),note=left(p_note,500) where id=q.id;
end $$;
revoke all on function app.supplier_conversation(uuid),app.queue_supplier_operation(uuid,text,text,text,uuid),app.extension_supplier_queue(text[]),app.extension_claim_supplier_operation(uuid,text),app.extension_finish_supplier_operation(uuid,text,jsonb,text) from public,anon;
grant execute on function app.supplier_conversation(uuid),app.queue_supplier_operation(uuid,text,text,text,uuid),app.extension_supplier_queue(text[]),app.extension_claim_supplier_operation(uuid,text),app.extension_finish_supplier_operation(uuid,text,jsonb,text) to authenticated;
create function app.read_supplier_operation(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare q app.supplier_operations;i app.items;begin
 select * into q from app.supplier_operations where id=p_id;select * into i from app.items where id=q.item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()),false) then raise exception '権限がありません' using errcode='42501';end if;
 return jsonb_build_object('status',q.status,'note',q.note);
end $$;
revoke all on function app.read_supplier_operation(uuid) from public,anon;
grant execute on function app.read_supplier_operation(uuid) to authenticated;

-- Conversation cleanup must not remove an active supplier-return discussion.
do $$declare definition text;begin
 definition:=pg_get_functiondef('app.purge_expired_marketplace_messages()'::regprocedure);
 definition:=replace(definition,'i.packed_completed_at is not null','i.status not in (''動作不良'',''Amazon補填申請中'',''取引中'') and i.packed_completed_at is not null');
 execute definition;
end $$;
create function app.read_seller_operation(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
declare q app.seller_operations;i app.items;begin
 select * into q from app.seller_operations where id=p_id;select * into i from app.items where id=q.item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) or not coalesce(app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()),false) then raise exception '権限がありません' using errcode='42501';end if;
 return jsonb_build_object('status',q.status,'note',q.result->>'note');
end $$;
revoke all on function app.read_seller_operation(uuid) from public,anon;
grant execute on function app.read_seller_operation(uuid) to authenticated;

create index seller_operations_item_time on app.seller_operations(item_id,created_at desc);
create index supplier_operations_item_time on app.supplier_operations(item_id,created_at desc);
create index supplier_messages_item_time on app.marketplace_messages(item_id,(coalesce(sent_at,synced_at)) desc);
notify pgrst,'reload schema';
