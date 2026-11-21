-- 仕入先へ返品した商品（返品処理）も、返金を確認するまで管理アプリのやることに
-- 「動作不良(返金待ち)」として残す。完了を押したら仕入金額の全額が返金されたものとして記録する
-- （返金額の入力欄は無いため。2026-11-21 ユーザー指定）。

-- 返金待ちの元になった出来事：返品不可の判断、または仕入先への返品完了（返品処理中のみ）。
create function app.supplier_refund_wait_event(p_item app.items) returns uuid
language sql stable security invoker set search_path=pg_catalog,app as $$
  select coalesce(
    app.supplier_return_impossible_event(p_item),
    (select e.id
     from app.inventory_workflow_events e
     where (p_item).status='返品処理'
       and e.item_id=(p_item).id and e.action='supplier_return_complete'
     order by e.created_at desc,e.id desc
     limit 1)
  )
$$;
revoke all on function app.supplier_refund_wait_event(app.items) from public,anon,authenticated;
grant execute on function app.supplier_refund_wait_event(app.items) to authenticated,service_role;

create or replace function app.complete_supplier_refund_task(p_item_id uuid,p_return_event_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,app as $$
declare
  actor uuid := app.current_staff_id();
  item app.items;
begin
  if auth.uid() is null or actor is null
     or not exists(select 1 from app.staff where id=actor and is_active) then
    raise exception 'ログインが必要です' using errcode='42501';
  end if;

  select * into item from app.items where id=p_item_id for no key update;
  if not found or not coalesce(app.is_admin() or (app.current_role()='purchaser' and item.purchaser_id=actor),false) then
    raise exception 'このやることを完了する権限がありません' using errcode='42501';
  end if;
  if p_return_event_id is null or p_return_event_id is distinct from app.supplier_refund_wait_event(item) then
    raise exception '返金待ちの状況が更新されています。一覧を再読み込みしてください' using errcode='40001';
  end if;

  -- The item lock serializes repeated confirmations for the same return decision.
  insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note)
  select gen_random_uuid(),item.id,actor,'supplier_refund_confirmed',item.status,item.status,p_return_event_id::text
  where not exists (
    select 1 from app.inventory_workflow_events e
    where e.item_id=item.id and e.action='supplier_refund_confirmed' and e.note=p_return_event_id::text
  );

  -- 完了＝仕入金額の全額が返金された（返金額がまだ記録されていない場合だけ）。
  update app.items
  set non_amazon_refund_amount=coalesce(item.cost_amount,0)
  where id=item.id and non_amazon_refund_amount=0 and coalesce(item.cost_amount,0)>0;
end;
$$;
revoke all on function app.complete_supplier_refund_task(uuid,uuid) from public,anon,authenticated;
grant execute on function app.complete_supplier_refund_task(uuid,uuid) to authenticated;

do $patch$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  old_event constant text := 'select app.supplier_return_impossible_event(i) as return_event_id';
  new_event constant text := 'select app.supplier_refund_wait_event(i) as return_event_id';
begin
  if strpos(definition, old_event)=0 then
    raise exception 'Supplier refund snapshot branch not found';
  end if;
  execute replace(definition, old_event, new_event);
end
$patch$;
notify pgrst, 'reload schema';
