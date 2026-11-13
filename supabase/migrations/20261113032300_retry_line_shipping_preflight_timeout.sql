-- A Mercari shipping preflight timeout occurs before any settings change or
-- code issuance. Allow one retry on the existing patrol, preserving all
-- guards for operations that may have issued a code.
do $migration$
declare
  definition text := pg_get_functiondef('app.extension_prepare_line_shipping(text[])'::regprocedure);
  old_guard text := $old$  if exists(select 1 from app.seller_operations where item_id=i.id and kind='shipping_code' and payload->>'trade_key'=o.current_trade and payload ? 'automatic_line') then$old$;
  new_guard text := $new$  if exists (
   select 1 from app.seller_operations prior
   where prior.item_id=i.id and prior.kind='shipping_code'
     and prior.payload->>'trade_key'=o.current_trade and prior.payload ? 'automatic_line'
     and (
       prior.channel <> 'メルカリ' or prior.account_id is distinct from o.account_id
       or prior.status <> 'failed' or prior.finished_at is null
       or prior.result->>'phase' is distinct from 'prepare'
       or prior.result->>'note' is distinct from '取引画面の発送情報の読み込みが時間切れになりました。コードは発行していません'
     )
  ) or (
   select count(*) from app.seller_operations prior
   where prior.item_id=i.id and prior.kind='shipping_code'
     and prior.payload->>'trade_key'=o.current_trade and prior.payload ? 'automatic_line'
  ) >= 2 then$new$;
begin
  if strpos(definition, new_guard) > 0 then return; end if;
  if strpos(definition, old_guard) = 0 then
    raise exception 'LINE shipping retry guard has changed';
  end if;
  execute replace(definition, old_guard, new_guard);
end;
$migration$;
