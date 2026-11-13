-- Add display details to inspection reminders without changing their deadline rules.
do $migration$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  updated text;
begin
  updated := replace(definition,
    $old$select to_jsonb(t) d from app.v_admin_work_deadlines t where t.kind='inspection'$old$,
    $new$select to_jsonb(t)||jsonb_build_object(
      'purchase_account_label',app.inventory_marketplace_accounts(i.id)->>'purchase_account_label',
      'model_no',case when i.is_accessory and t.action_item_id<>t.item_id then null else p.model_no end,
      'title',i.title,
      'waiting_for_parts',parts.member_count>1 and parts.unconfirmed
    ) d
    from app.v_admin_work_deadlines t
    join app.items i on i.id=t.item_id
    left join app.products p on p.id=i.product_id
      or (i.product_id is null and i.marketplace='動作品Amazon返品' and p.asin=i.asin)
    cross join lateral (
      select count(*) as member_count,
        bool_or(nullif(btrim(member.tracking_no),'') is null or (
          member.inspected_at is null and member.malfunction_reported_at is null
          and not exists (
            select 1 from app.marketplace_extension_receipts receipt
            where receipt.marketplace=app.receipt_purchase_market(member.marketplace)
              and receipt.marketplace_item_id=member.marketplace_item_id
              and receipt.state='succeeded'
          )
        )) as unconfirmed
      from app.items member
      where member.id=t.action_item_id
        or (member.parent_item_id=t.action_item_id and member.is_accessory
          and not app.is_standalone_accessory_serial(member.sku,member.lot_seq))
    ) parts
    where t.kind='inspection'$new$);
  if updated = definition then
    raise exception 'Admin inspection snapshot source not found';
  end if;
  execute updated;
end $migration$;

notify pgrst, 'reload schema';
