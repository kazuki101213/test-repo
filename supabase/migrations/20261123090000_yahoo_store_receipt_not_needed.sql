-- Yahoo store purchases need no 受け取り連絡 (Yahoo shows 「ストアから購入した商品は受取連絡は必要ありません」).
-- The extension calls this only after reading that sentence on the store order page.
create or replace function app.extension_mark_yahoo_store_receipt_not_needed(p_item_id text)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id text := nullif(btrim(coalesce(p_item_id, '')), '');
  v_count integer;
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  if v_id is null or v_id !~ '^(?:[a-zA-Z]\d{8,14}|\d{10})$' then
    raise exception 'ヤフオクの商品IDが不正です' using errcode = '22023';
  end if;
  update app.receipt_evaluation_tasks t
     set completed_at = clock_timestamp(),
         completed_by = coalesce(t.completed_by, app.current_staff_id())
    from app.items i
   where i.id = t.item_id
     and t.completed_at is null
     and i.marketplace_item_id = v_id
     and app.receipt_purchase_market(i.marketplace) = app.receipt_purchase_market('ヤフオク'::app.marketplace);
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;
revoke all on function app.extension_mark_yahoo_store_receipt_not_needed(text) from public, anon;
grant execute on function app.extension_mark_yahoo_store_receipt_not_needed(text) to authenticated;
