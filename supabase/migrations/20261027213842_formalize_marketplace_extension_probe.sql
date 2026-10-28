-- Preserve the live tracking probe; bootstrap its existing definition on fresh databases.
do $bootstrap$
begin
 if to_regprocedure('app.marketplace_extension_probe(app.marketplace,text)') is null then
  execute $definition$
  create function app.marketplace_extension_probe(p_marketplace app.marketplace,p_item_id text)
  returns jsonb language plpgsql security invoker set search_path=app,public as $body$
  declare v_items jsonb;
  begin
   if auth.uid() is null or not app.is_admin() then raise exception '管理者認証が必要です';end if;
   if p_marketplace not in ('メルカリ','ヤフオク','ヤフフリ','PayPayフリマ','ラクマ') or nullif(trim(p_item_id),'') is null or length(p_item_id)>100 then raise exception '照合条件が不正です';end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',id,'sku',sku,'marketplace',marketplace,'tracking_no',tracking_no,'inspected_at',inspected_at,'cleaned_at',cleaned_at)),'[]'::jsonb)
    into v_items from app.items
    where marketplace_item_id=p_item_id and (marketplace=p_marketplace or (p_marketplace in ('ヤフフリ','PayPayフリマ') and marketplace in ('ヤフフリ','PayPayフリマ')));
   return jsonb_build_object('items',v_items,'count',jsonb_array_length(v_items));
  end $body$;
  $definition$;
 end if;
end $bootstrap$;
revoke all on function app.marketplace_extension_probe(app.marketplace,text) from public,anon;
grant execute on function app.marketplace_extension_probe(app.marketplace,text) to authenticated;
