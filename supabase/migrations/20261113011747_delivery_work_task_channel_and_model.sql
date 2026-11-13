-- Enrich the existing delivery task snapshot with the inventory display fields.
do $migration$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  updated text;
begin
  updated := replace(definition,
    $old$select to_jsonb(t) d from app.v_delivery_work_tasks t$old$,
    $new$select to_jsonb(t) || case t.kind
      when 'inspection' then jsonb_build_object('model_no',p.model_no,'title',i.title)
      when 'shipping' then jsonb_build_object('sales_channel',i.sales_channel,
        'sales_account_label',app.inventory_marketplace_accounts(i.id)->>'sales_account_label')
      else '{}'::jsonb
    end d
    from app.v_delivery_work_tasks t
    left join app.items i on i.id=t.item_id and t.kind in ('inspection','shipping')
    left join app.products p on t.kind='inspection' and
      (p.id=i.product_id or (i.product_id is null and i.marketplace='動作品Amazon返品' and p.asin=i.asin))$new$);
  if updated = definition then
    raise exception 'Delivery work task snapshot source not found';
  end if;
  execute updated;
end $migration$;

notify pgrst, 'reload schema';
