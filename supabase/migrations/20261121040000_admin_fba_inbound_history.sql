-- 管理アプリの在庫画面「FBA納品」タブ用。納品プランと出荷・商品の履歴を管理者だけが読み取る。
-- 読み取り専用。Amazonへの送信や納品プランの変更は行わない。
create or replace function app.admin_fba_inbound_history(p_limit integer default 200)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_data order by created_at desc)
    from (
      select p.created_at,
        jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'account', p.account,
          'stage', p.stage,
          'staff', case when s.id is null then null else jsonb_build_object('code', s.code, 'name', s.name, 'display_name', s.display_name) end,
          'created_at', p.created_at,
          'updated_at', p.updated_at,
          'received_at', p.received_at,
          'has_amazon_plan', p.amazon_id is not null,
          'waiting_amazon', p.pending is not null,
          'dispatch_requested_at', p.work->>'dispatchRequestedAt',
          'ship_date', p.work->>'shipDate',
          'shipments', coalesce((
            select jsonb_agg(jsonb_build_object(
              'confirmation_id', sh->>'confirmationId',
              'warehouse', sh->>'warehouse',
              'status', sh->>'status',
              'tracking', coalesce((
                select jsonb_agg(distinct b->>'tracking')
                from jsonb_array_elements(coalesce(sh->'boxes', '[]'::jsonb)) b
                where nullif(btrim(b->>'tracking'), '') is not null), '[]'::jsonb),
              'boxes', jsonb_array_length(coalesce(sh->'boxes', '[]'::jsonb)),
              'received', coalesce(sh->'received', '{}'::jsonb)))
            from jsonb_array_elements(coalesce(p.work->'shipments', '[]'::jsonb)) sh), '[]'::jsonb),
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'item_id', f.item_id,
              'sku', f.sku,
              'title', f.title,
              'serial', i.lot_seq,
              'status', i.status,
              'current_sku', i.sku,
              'published_at', f.published_at,
              'released_at', f.released_at) order by f.sku)
            from app.fba_inbound_items f
            left join app.items i on i.id = f.item_id
            where f.plan_id = p.id), '[]'::jsonb)
        ) as row_data
      from app.fba_inbound_plans p
      left join app.staff s on s.id = p.staff_id
      order by p.created_at desc
      limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) plans
  ), '[]'::jsonb);
end
$function$;

revoke all on function app.admin_fba_inbound_history(integer) from public, anon;
grant execute on function app.admin_fba_inbound_history(integer) to authenticated;
