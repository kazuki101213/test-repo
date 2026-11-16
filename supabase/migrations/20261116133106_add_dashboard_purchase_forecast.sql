create function app.read_dashboard_purchase_forecast(p_month date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
 purchaser_ids uuid[];
begin
 if not coalesce(app.management_reports_allowed(), false) then
  raise exception '閲覧する権限がありません' using errcode = '42501';
 end if;
 if p_month is null or extract(day from p_month) <> 1 then
  raise exception '対象月を確認してください' using errcode = '22023';
 end if;

 purchaser_ids := app.dashboard_purchaser_ids();
 return (
  select jsonb_build_object(
   'all', coalesce(sum(v.expected_profit), 0),
   'mine', coalesce(sum(v.expected_profit) filter (where i.purchaser_id = any(purchaser_ids)), 0)
  )
  from app.v_financial_families f
  join app.items i on i.id = f.origin_item_id
  join app.v_inventory_display v on v.id = i.id
  where f.origin_purchased_at >= p_month and f.origin_purchased_at < p_month + interval '1 month'
 );
end $$;
revoke all on function app.read_dashboard_purchase_forecast(date) from public, anon, authenticated;
grant execute on function app.read_dashboard_purchase_forecast(date) to authenticated;
notify pgrst, 'reload schema';
