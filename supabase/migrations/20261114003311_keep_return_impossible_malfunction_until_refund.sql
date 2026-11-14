-- Keep the delivery decision separate from the management refund follow-up.
-- Use the action that resolved the current report to distinguish it from a
-- normal Yahoo listing instruction, which writes the same inventory status.
do $patch$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  previous_source constant text := $old$ when 'malfunctions' then source:=$q$select to_jsonb(s) d from (select i.id,i.sku,i.lot_seq,i.title,i.asin,i.marketplace_item_id,i.purchaser_id,i.deliverer_id,i.malfunction_comment,i.malfunction_reported_at,i.malfunction_reported_by,i.status,
 jsonb_build_array(jsonb_build_object('model_no',p.model_no)) products,a.maker maker,
 jsonb_build_array(jsonb_build_object('id',b.id,'name',b.name),jsonb_build_object('id',d.id,'name',d.name),jsonb_build_object('id',r.id,'name',r.name)) people
 from app.items i left join app.products p on p.id=i.product_id left join app.products a on a.asin=i.asin and a.is_active
 left join app.staff b on b.id=i.purchaser_id left join app.staff d on d.id=i.deliverer_id left join app.staff r on r.id=i.malfunction_reported_by
 where (i.status<>'Amazon補填申請中' or i.compensation_report_completed_for is distinct from i.malfunction_reported_at)
      and (i.status<>'動作不良' or not exists(select 1 from app.malfunction_task_completions done where done.item_id=i.id and done.reported_at=i.malfunction_reported_at)) and i.malfunction_reported and i.malfunction_resolved_at is null and i.status in ('動作不良','Amazon補填申請中') and i.sold_on is null and (app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))) s$q$;$old$;
  new_source constant text := $new$ when 'malfunctions' then source:=$q$
    select to_jsonb(s) d from (
      select i.id,i.sku,i.lot_seq,i.title,i.asin,i.marketplace_item_id,i.purchaser_id,i.deliverer_id,
        i.malfunction_comment,i.malfunction_reported_at,i.malfunction_reported_by,i.status,
        refund.supplier_refund_pending,
        jsonb_build_array(jsonb_build_object('model_no',p.model_no)) products,a.maker maker,
        jsonb_build_array(jsonb_build_object('id',b.id,'name',b.name),
          jsonb_build_object('id',d.id,'name',d.name),jsonb_build_object('id',r.id,'name',r.name)) people
      from app.items i
      left join app.products p on p.id=i.product_id
      left join app.products a on a.asin=i.asin and a.is_active
      left join app.staff b on b.id=i.purchaser_id
      left join app.staff d on d.id=i.deliverer_id
      left join app.staff r on r.id=i.malfunction_reported_by
      cross join lateral (
        select coalesce(i.workflow_decision='yahoo'
          and i.malfunction_resolved_at>=i.malfunction_reported_at
          and i.non_amazon_refund_amount=0
          and exists (
            select 1 from app.inventory_workflow_events e
            where e.item_id=i.id and e.action='return_impossible'
              and e.created_at>=i.malfunction_resolved_at
          ), false) as supplier_refund_pending
      ) refund
      where (app.is_admin() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id()))
        and (
          refund.supplier_refund_pending
          or (i.malfunction_reported and i.malfunction_resolved_at is null and i.sold_on is null
            and (
              (i.status='Amazon補填申請中' and i.compensation_report_completed_for is distinct from i.malfunction_reported_at)
              or (i.status='動作不良' and not exists (
                select 1 from app.malfunction_task_completions done
                where done.item_id=i.id and done.reported_at=i.malfunction_reported_at
              ))
            )
          )
        )
    ) s$q$;$new$;
begin
  if strpos(definition, previous_source)=0 then
    raise exception 'Management malfunction snapshot source changed';
  end if;
  execute replace(definition, previous_source, new_source);
end;
$patch$;
