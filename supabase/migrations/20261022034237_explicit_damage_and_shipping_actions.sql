alter table app.items add column has_physical_damage boolean not null default false;
alter table app.inventory_workflow_events add column has_physical_damage boolean not null default false;
comment on column app.items.has_physical_damage is 'Explicit damage checkbox from the current malfunction report; never inferred from condition.';

create function app.reset_report_physical_damage() returns trigger language plpgsql set search_path=pg_catalog,app as $$
begin
 if new.malfunction_reported_at is distinct from old.malfunction_reported_at then new.has_physical_damage:=false; end if;
 return new;
end $$;
create trigger items_reset_report_physical_damage before update on app.items for each row execute function app.reset_report_physical_damage();

create function app.report_item_with_damage(p_item_id uuid,p_expected_status app.item_status,p_note text,p_request_id uuid,p_photo_ids uuid[],p_has_physical_damage boolean)
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare actor uuid:=app.current_staff_id(); i app.items; e app.inventory_workflow_events;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id for update;
 if i.id is null or not (app.is_admin() or i.deliverer_id=actor or (app.current_role()='purchaser' and i.purchaser_id=actor)) then raise exception '担当商品のみ報告できます' using errcode='42501';end if;
 if p_has_physical_damage is null then raise exception '破損の確認内容がありません' using errcode='22023';end if;
 select * into e from app.inventory_workflow_events where id=p_request_id;
 if found then
  if e.item_id<>i.id or e.actor_id<>actor or e.action<>'report' or e.note is distinct from nullif(btrim(p_note),'') or e.has_physical_damage<>p_has_physical_damage then raise exception '操作IDが重複しています' using errcode='22023';end if;
  return;
 end if;
 if coalesce(cardinality(p_photo_ids),0)>0 then perform app.submit_malfunction_report(p_item_id,p_expected_status,p_note,p_request_id,p_photo_ids);
 else perform app.perform_inventory_action(p_item_id,'report',p_expected_status,p_note,p_request_id);end if;
 update app.items set has_physical_damage=p_has_physical_damage where id=p_item_id;
 update app.inventory_workflow_events set has_physical_damage=p_has_physical_damage where id=p_request_id;
end $$;
revoke all on function app.report_item_with_damage(uuid,app.item_status,text,uuid,uuid[],boolean) from public,anon;
grant execute on function app.report_item_with_damage(uuid,app.item_status,text,uuid,uuid[],boolean) to authenticated;

do $$declare d text;begin
 select pg_get_viewdef('app.v_delivery_tasks'::regclass,true) into d;
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as select v.*,i.has_physical_damage from ('||d||') v join app.items i on i.id=v.id';
end $$;

-- A generated code plus the user's explicit shipment confirmation replaces the UI receipt scan.
-- Keep the old proof paths for already-loaded clients and post-box packages.
do $$declare d text; old_guard text:=$guard$(proof.kind='register_package' and (p_payload->>'posted')::boolean is true)$guard$;begin
 select pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure) into d;
 if position(old_guard in d)=0 then raise exception 'Shipping proof guard changed; review before patching';end if;
 d:=replace(d,old_guard,$guard$(proof.kind in ('register_package','shipping_code') and (p_payload->>'posted')::boolean is true)$guard$);
 execute d;
end $$;
