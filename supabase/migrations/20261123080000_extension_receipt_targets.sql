-- Yahoo buyer receipt: the extension checks only the app's 受け取り連絡待ち items
-- instead of opening every inspected won trade.
create or replace function app.extension_receipt_targets(p_marketplace app.marketplace)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'item_id', btrim(v.marketplace_item_id),
      'account', i.purchase_account_id,
      'purchased_at', i.purchased_at
    ) order by v.requested_at)
    from app.v_receipt_evaluation_tasks v
    join app.items i on i.id = v.item_id
    where app.receipt_purchase_market(v.marketplace) = app.receipt_purchase_market(p_marketplace)
      and nullif(btrim(v.marketplace_item_id), '') is not null
  ), '[]'::jsonb);
end
$function$;
revoke all on function app.extension_receipt_targets(app.marketplace) from public, anon;
grant execute on function app.extension_receipt_targets(app.marketplace) to authenticated;
