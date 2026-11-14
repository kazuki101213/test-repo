-- Identify the delivery decision for this report even after the item is listed or sold.
create function app.supplier_return_impossible_event(p_item app.items) returns uuid
language sql stable security invoker set search_path=pg_catalog,app as $$
  select e.id
  from app.inventory_workflow_events e
  where (p_item).workflow_decision='yahoo'
    and (p_item).malfunction_resolved_at>=(p_item).malfunction_reported_at
    and e.item_id=(p_item).id and e.action='return_impossible'
    and e.created_at>=(p_item).malfunction_resolved_at
  order by e.created_at desc,e.id desc
  limit 1
$$;
revoke all on function app.supplier_return_impossible_event(app.items) from public,anon,authenticated;
grant execute on function app.supplier_return_impossible_event(app.items) to authenticated,service_role;

create function app.complete_supplier_refund_task(p_item_id uuid,p_return_event_id uuid) returns void
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
  if p_return_event_id is null or p_return_event_id is distinct from app.supplier_return_impossible_event(item) then
    raise exception '返金待ちの状況が更新されています。一覧を再読み込みしてください' using errcode='40001';
  end if;

  -- The item lock serializes repeated confirmations for the same return decision.
  insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note)
  select gen_random_uuid(),item.id,actor,'supplier_refund_confirmed',item.status,item.status,p_return_event_id::text
  where not exists (
    select 1 from app.inventory_workflow_events e
    where e.item_id=item.id and e.action='supplier_refund_confirmed' and e.note=p_return_event_id::text
  );
end;
$$;
revoke all on function app.complete_supplier_refund_task(uuid,uuid) from public,anon,authenticated;
grant execute on function app.complete_supplier_refund_task(uuid,uuid) to authenticated;

do $patch$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  old_refund constant text := $old$      cross join lateral (
        select coalesce(i.workflow_decision='yahoo'
          and i.malfunction_resolved_at>=i.malfunction_reported_at
          and i.non_amazon_refund_amount=0
          and exists (
            select 1 from app.inventory_workflow_events e
            where e.item_id=i.id and e.action='return_impossible'
              and e.created_at>=i.malfunction_resolved_at
          ), false) as supplier_refund_pending
      ) refund$old$;
  new_refund constant text := $new$      left join lateral (
        select app.supplier_return_impossible_event(i) as return_event_id
        where i.non_amazon_refund_amount=0
      ) decision on true
      left join lateral (
        select decision.return_event_id as supplier_refund_event_id,true as supplier_refund_pending
        where decision.return_event_id is not null
          and not exists (
            select 1 from app.inventory_workflow_events e
            where e.item_id=i.id and e.action='supplier_refund_confirmed' and e.note=decision.return_event_id::text
          )
      ) refund on true$new$;
begin
  if strpos(definition, old_refund)=0 or strpos(definition,'refund.supplier_refund_pending,')=0 then
    raise exception 'Management refund task snapshot source changed';
  end if;
  execute replace(replace(definition,old_refund,new_refund),
    'refund.supplier_refund_pending,','coalesce(refund.supplier_refund_pending,false) as supplier_refund_pending,refund.supplier_refund_event_id,');
end;
$patch$;

notify pgrst,'reload schema';
