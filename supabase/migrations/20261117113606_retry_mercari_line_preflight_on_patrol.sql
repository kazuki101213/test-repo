-- Retry Mercari navigation interruptions on the existing LINE patrol.
-- Both allowed notes are emitted before a code or shipping settings can change.
do $migration$
declare
  definition text := pg_get_functiondef('app.extension_prepare_line_shipping(text[])'::regprocedure);
  old_guard text := $old$       or prior.result->>'phase' is distinct from 'prepare'
       or prior.result->>'note' is distinct from '取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません'
     )
  ) or (
   select count(*) from app.seller_operations prior
   where prior.item_id=i.id and prior.kind='shipping_code'
     and prior.payload->>'trade_key'=o.current_trade and prior.payload ? 'automatic_line'
  ) >= 2 then$old$;
  new_guard text := $new$       or prior.result->>'phase' is distinct from 'prepare'
       or coalesce(prior.result->>'note','') not in (
         '取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません',
         '画面確認待ち: 待機中にタブが変更されたため停止しました'
       )
       -- An interrupted RPC or two overlapping patrols must not hot-loop.
       or prior.finished_at > clock_timestamp() - interval '5 minutes'
     )
  ) then$new$;
begin
  if strpos(definition,new_guard) > 0 then return; end if;
  if strpos(definition,old_guard) = 0 then
    raise exception 'Expected LINE preflight retry guard not found';
  end if;
  execute replace(definition,old_guard,new_guard);
end;
$migration$;
