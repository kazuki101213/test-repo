-- 2026-11-24: 拡張機能の操作（出品・発送コード取得・発送連絡・仕入れ先への連絡など）が
-- 停止（failed）または結果不明（uncertain）になったら、売れました通知と同じ管理者向け通知を出す。
-- アプリ側で取り消した操作（返品完了の取消など）は通知しない。

create or replace function app.notify_operation_failure()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  item_no text;
  label text;
  note text;
  body text;
begin
  if TG_TABLE_NAME = 'seller_operations' then
    label := case new.kind
      when 'listing' then '出品'
      when 'shipping_code' then '発送コード取得'
      when 'ship_notice' then '発送連絡'
      when 'verify_shipping' then '発送の受付確認'
      when 'message_sync' then '取引メッセージ取得'
      else new.kind end;
    note := new.result->>'note';
  else
    label := case new.kind
      when 'send' then '仕入れ先へのメッセージ送信'
      when 'read' then '仕入れ先メッセージの取得'
      else new.kind end;
    note := new.note;
    if coalesce(note, '') ~ '取り消' then return new; end if;
  end if;

  select nullif(split_part(i.sku, '-', 1), '') into item_no from app.items i where i.id = new.item_id;
  body := coalesce('【' || item_no || '】', '')
    || label
    || case when new.status = 'uncertain' then 'の結果を確認できません' else 'が止まりました' end
    || coalesce('：' || nullif(btrim(note), ''), '');

  begin
    perform app.record_sale_notice(
      jsonb_build_array('operation-' || new.status, TG_TABLE_NAME, new.id::text)::text,
      new.item_id,
      left(body, 250));
  exception when others then
    -- 通知に失敗しても、拡張機能の結果の記録は止めない。
    raise warning 'operation failure notice skipped: %', sqlerrm;
  end;
  return new;
end
$function$;

revoke all on function app.notify_operation_failure() from public, anon, authenticated;

drop trigger if exists seller_operations_notify_failure on app.seller_operations;
create trigger seller_operations_notify_failure
  after update of status on app.seller_operations
  for each row
  when (new.status in ('failed', 'uncertain') and old.status is distinct from new.status)
  execute function app.notify_operation_failure();

drop trigger if exists supplier_operations_notify_failure on app.supplier_operations;
create trigger supplier_operations_notify_failure
  after update of status on app.supplier_operations
  for each row
  when (new.status in ('failed', 'uncertain') and old.status is distinct from new.status)
  execute function app.notify_operation_failure();
