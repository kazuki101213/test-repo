alter table app.items add column return_tracking_no text;
comment on column app.items.return_tracking_no is '仕入先への返品時に登録した追跡番号';

-- Reuse the inventory action's authorization, state checks and request idempotency.
do $patch$
declare original text; patched text;
begin
  original:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
  patched:=replace(original,
    'target:=''返品処理'';update app.items set returned_on=(clock_timestamp() at time zone ''Asia/Tokyo'')::date,status=target where id=i.id;',
    'if nullif(btrim(p_note),'''') is null or p_note !~ ''[[:alnum:]]''
      or p_note ~ ''[[:cntrl:]]'' or length(btrim(p_note))>100 then
    raise exception ''返品の追跡番号を入力してください'' using errcode=''22023'';
  end if;
  target:=''返品処理'';
  update app.items set returned_on=(clock_timestamp() at time zone ''Asia/Tokyo'')::date,
    return_tracking_no=btrim(p_note),status=target where id=i.id;');
  if patched=original then raise exception 'Supplier return action source changed'; end if;
  original:=patched;
  patched:=replace(original,'set returned_on=null,malfunction_reported=true',
    'set returned_on=null,return_tracking_no=null,malfunction_reported=true');
  if patched=original then raise exception 'Supplier return cancellation source changed'; end if;
  execute patched;

  original:=rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),E';\n ');
  execute 'create or replace view app.v_delivery_tasks with (security_invoker=true) as
    select task.*,i.return_tracking_no from ('||original||') task join app.items i on i.id=task.id';
end;
$patch$;

create function app.complete_supplier_return(
  p_item_id uuid, p_work_completed_on date, p_tracking_no text, p_request_id uuid
) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare
  item app.items;
  actor uuid:=app.current_staff_id();
  previous_date text:=current_setting('app.work_completed_on',true);
begin
  if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;
  select * into item from app.items where id=p_item_id for update;
  if not found or not coalesce(app.is_admin() or item.deliverer_id=actor,false) then
    raise exception 'この商品の返品を登録できません' using errcode='42501';
  end if;
  perform app.validate_work_completion_date(p_work_completed_on,item.purchased_at);
  perform set_config('app.work_completed_on',p_work_completed_on::text,true);
  perform app.perform_inventory_action(p_item_id,'supplier_return_complete','動作不良',btrim(p_tracking_no),p_request_id);
  perform set_config('app.work_completed_on',coalesce(previous_date,''),true);
end;
$$;
revoke all on function app.complete_supplier_return(uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function app.complete_supplier_return(uuid,date,text,uuid) to authenticated;
notify pgrst,'reload schema';
