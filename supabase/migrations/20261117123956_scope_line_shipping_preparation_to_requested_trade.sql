-- Use the ordinary LINE preparation logic for an explicitly requested current trade.
do $migration$
declare
  source text := pg_get_functiondef('app.extension_prepare_line_shipping(text[])'::regprocedure);
  old_scope text := $old$ where q.state='pending' and q.attempts=0$old$;
  new_scope text := $new$ where q.state='pending' and q.attempts=0
   and (p_item_id is null or (t.item_id=p_item_id and q.trade_key=p_trade_key and l.trade_key=p_trade_key))$new$;
begin
  if strpos(source,'p_account_ids text[])')=0 or strpos(source,old_scope)=0
     or strpos(source,' perform app.ensure_line_shipping_requests();')=0
     or strpos(source,$anchor$ return jsonb_build_object('queued',n);$anchor$)=0 then
    raise exception 'Expected LINE preparation function not found';
  end if;
  source := replace(source,'p_account_ids text[])','p_account_ids text[], p_item_id uuid, p_trade_key text)');
  source := replace(source,old_scope,new_scope);
  source := replace(source,' perform app.ensure_line_shipping_requests();',$body$ if (p_item_id is null) <> (p_trade_key is null)
  or (p_item_id is not null and (cardinality(p_account_ids) is distinct from 1 or length(p_trade_key) not between 3 and 160)) then
   raise exception '対象取引を確認してください' using errcode='22023';
 end if;
 if p_item_id is null then perform app.ensure_line_shipping_requests(); end if;$body$);
  source := replace(source,$anchor$ return jsonb_build_object('queued',n);$anchor$,$body$ if p_item_id is not null and n=1 then
   return jsonb_build_object('queued',n,'operationId',operation);
 end if;
 return jsonb_build_object('queued',n);$body$);
  execute source;
end;
$migration$;

revoke all on function app.extension_prepare_line_shipping(text[],uuid,text) from public,anon;
grant execute on function app.extension_prepare_line_shipping(text[],uuid,text) to authenticated;

create or replace function app.extension_prepare_line_shipping(p_account_ids text[])
returns jsonb language sql security definer set search_path='' as $function$
 select app.extension_prepare_line_shipping(p_account_ids,null::uuid,null::text);
$function$;

notify pgrst,'reload schema';
