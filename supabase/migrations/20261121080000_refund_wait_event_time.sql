-- 管理アプリの「動作不良(返金待ち)(○日経過)」用に、返金待ちの元になった出来事
-- （返品完了・返品不可の判断）の日時を返す（2026-11-21 ユーザー指定）。
do $patch$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  old_select constant text := 'refund.supplier_refund_event_id,';
  new_select constant text := 'refund.supplier_refund_event_id,refund.supplier_refund_event_at,';
  old_lateral constant text := 'select decision.return_event_id as supplier_refund_event_id,true as supplier_refund_pending';
  new_lateral constant text := 'select decision.return_event_id as supplier_refund_event_id,true as supplier_refund_pending,'
    || '(select ev.created_at from app.inventory_workflow_events ev where ev.id=decision.return_event_id) as supplier_refund_event_at';
begin
  if strpos(definition, old_select)=0 or strpos(definition, old_lateral)=0
     or strpos(definition, 'supplier_refund_event_at')>0 then
    raise exception 'Supplier refund snapshot branch changed unexpectedly';
  end if;
  execute replace(replace(definition, old_select, new_select), old_lateral, new_lateral);
end
$patch$;
notify pgrst, 'reload schema';
