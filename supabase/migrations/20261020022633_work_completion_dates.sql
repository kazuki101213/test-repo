-- The historical column is retained so saved dates and invoice months stay intact.
comment on column app.items.packed_on is '作業完了日（旧梱包日）。請求対象月の判定に使用';
alter table app.seller_operations add column work_completed_on date;
alter table app.items add column compensation_report_completed_for timestamptz;

create function app.validate_work_completion_date(p_on date,p_purchased date) returns void
language plpgsql set search_path=pg_catalog,app as $$begin
 if p_on is null or p_on>(clock_timestamp() at time zone 'Asia/Tokyo')::date or p_on<p_purchased then
  raise exception '作業完了日は仕入日以降、当日までの日付を入力してください' using errcode='22023';end if;
end $$;
revoke all on function app.validate_work_completion_date(date,date) from public,anon,authenticated;

create function app.capture_listing_work_date() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$declare purchased date;begin
 if new.kind='listing' then
  select purchased_at into purchased from app.items where id=new.item_id;
  new.work_completed_on:=coalesce(nullif(new.payload->>'work_completed_on','')::date,(clock_timestamp() at time zone 'Asia/Tokyo')::date);
  perform app.validate_work_completion_date(new.work_completed_on,purchased);
 end if;
 return new;
end $$;
revoke all on function app.capture_listing_work_date() from public,anon,authenticated;
create trigger seller_operations_capture_work_date before insert on app.seller_operations for each row execute function app.capture_listing_work_date();

-- External listings record the chosen date only after success, including a later result check.
create function app.finish_listing_work_date() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$begin
 if new.kind='listing' and new.status='succeeded' and old.status is distinct from new.status then
  update app.items set packed_on=coalesce(new.work_completed_on,(new.created_at at time zone 'Asia/Tokyo')::date)
  where id=new.item_id and packed_on is null and sales_channel=new.channel
    and status in ('出品中','取引中','販売済') and product_registered_at is not null;
 end if;
 return new;
end $$;
revoke all on function app.finish_listing_work_date() from public,anon,authenticated;
create trigger seller_operations_finish_work_date after update of status on app.seller_operations for each row execute function app.finish_listing_work_date();

-- Manual FBA/self listing and supplier return remain atomic with their inventory actions.
create function app.record_work_completion_date() returns trigger
language plpgsql set search_path=pg_catalog,app as $$declare chosen date;begin
 if new.packed_on is not null or old.packed_on is not null then return new;end if;
 if (new.sales_channel in ('FBA','自己発送') and new.product_registered_at is not null and old.product_registered_at is null and new.status in ('出品中','取引中','販売済'))
 or (old.status<>'返品処理' and new.status='返品処理' and new.returned_on is not null) then
  chosen:=nullif(current_setting('app.work_completed_on',true),'')::date;
  new.packed_on:=coalesce(chosen,(clock_timestamp() at time zone 'Asia/Tokyo')::date);
  new.packed_completed_at:=coalesce(new.packed_completed_at,clock_timestamp());
 end if;
 return new;
end $$;
revoke all on function app.record_work_completion_date() from public,anon,authenticated;
create trigger zz_items_record_work_completion before update on app.items for each row execute function app.record_work_completion_date();

create function app.perform_dated_inventory_action(p_item_id uuid,p_action text,p_expected_status app.item_status,p_on date,p_request_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare i app.items;actor uuid:=app.current_staff_id();previous text:=current_setting('app.work_completed_on',true);event app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if p_action not in ('listing_complete','supplier_return_complete') then raise exception '日付登録の対象外です' using errcode='22023';end if;
 perform app.validate_work_completion_date(p_on,i.purchased_at);
 select * into event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if event.item_id=i.id and event.actor_id=actor and event.action=p_action then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';
 end if;
 perform set_config('app.work_completed_on',p_on::text,true);
 perform app.perform_inventory_action(p_item_id,p_action,p_expected_status,null,p_request_id);
 perform set_config('app.work_completed_on',coalesce(previous,''),true);
end $$;
revoke all on function app.perform_dated_inventory_action(uuid,text,app.item_status,date,uuid) from public,anon;
grant execute on function app.perform_dated_inventory_action(uuid,text,app.item_status,date,uuid) to authenticated;

create function app.complete_delivery_work(p_item_id uuid,p_on date) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$declare i app.items;actor uuid:=app.current_staff_id();begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=actor,false) then raise exception 'この商品の作業完了日は登録できません' using errcode='42501';end if;
 if i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq) then raise exception '本体から作業完了を登録してください' using errcode='22023';end if;
 perform app.validate_work_completion_date(p_on,i.purchased_at);
 if i.packed_on=p_on then return;end if;
 if i.packed_on is not null then raise exception '作業完了日は登録済みです。一覧を再読み込みしてください' using errcode='40001';end if;
 if i.status not in ('動作不良','Amazon補填申請中') then raise exception '動作不良・Amazon補填申請中の商品が対象です' using errcode='22023';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain'))
 or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '実行中の操作の結果を確認してください' using errcode='22023';end if;
 update app.items set packed_on=p_on where id=i.id;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note) values(gen_random_uuid(),i.id,actor,'work_complete',i.status,i.status,p_on::text);
end $$;
revoke all on function app.complete_delivery_work(uuid,date) from public,anon;
grant execute on function app.complete_delivery_work(uuid,date) to authenticated;

create function app.complete_delivery_compensation(p_item_id uuid,p_request_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$declare i app.items;actor uuid:=app.current_staff_id();event app.inventory_workflow_events;begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or i.deliverer_id=actor,false) then raise exception 'この商品を操作できません' using errcode='42501';end if;
 if p_request_id is null then raise exception '操作IDがありません' using errcode='22023';end if;
 select * into event from app.inventory_workflow_events where id=p_request_id;
 if found then
  if event.item_id=i.id and event.actor_id=actor and event.action='compensation_complete' then return;end if;
  raise exception '操作IDが重複しています' using errcode='22023';end if;
 if i.status<>'Amazon補填申請中' or i.sold_on is not null or i.is_accessory then raise exception 'Amazon補填申請中の本体が対象です' using errcode='22023';end if;
 if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) or exists(select 1 from app.supplier_operations where item_id=i.id and status in ('queued','running','uncertain')) then raise exception '実行中の操作の結果を確認してください' using errcode='22023';end if;
 update app.items set sales_channel='ヤフオク',workflow_decision='compensated',malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=actor,status='商品登録前' where id=i.id;
 insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status) values(p_request_id,i.id,actor,'compensation_complete',i.status,'商品登録前');
end $$;
revoke all on function app.complete_delivery_compensation(uuid,uuid) from public,anon;
grant execute on function app.complete_delivery_compensation(uuid,uuid) to authenticated;

create function app.complete_compensation_report(p_item_id uuid,p_reported_at timestamptz) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$declare i app.items;actor uuid:=app.current_staff_id();begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not coalesce(app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=actor),false) then raise exception '管理側のみ操作できます' using errcode='42501';end if;
 if i.status<>'Amazon補填申請中' or p_reported_at is null or i.malfunction_reported_at is distinct from p_reported_at then raise exception '報告が更新されています。一覧を再読み込みしてください' using errcode='40001';end if;
 update app.items set compensation_report_completed_for=p_reported_at where id=i.id and compensation_report_completed_for is distinct from p_reported_at;
end $$;
revoke all on function app.complete_compensation_report(uuid,timestamptz) from public,anon;
grant execute on function app.complete_compensation_report(uuid,timestamptz) to authenticated;

-- Filter only the acknowledged report; a fresh report on the same item is visible again.
do $$declare def text;begin
 select pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure) into def;
 if strpos(def,'where i.malfunction_reported and')=0 then raise exception 'Snapshot source changed; review before applying';end if;
 execute replace(def,'where i.malfunction_reported and','where (i.status<>''Amazon補填申請中'' or i.compensation_report_completed_for is distinct from i.malfunction_reported_at) and i.malfunction_reported and');
end $$;
do $$declare f record;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prokind='f' and p.prosrc like '%梱包完了から%' loop
 execute replace(pg_get_functiondef(f.oid),'梱包完了から','作業完了から');end loop;
end $$;
notify pgrst,'reload schema';
