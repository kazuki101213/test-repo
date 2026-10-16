-- The unified management mode is available only to administrators/purchasers.
-- Enforce the same boundary at the new reader, independently of legacy view grants.
do $guard$
declare definition text; marker text:=' -- Only whitelisted view names';
begin
 definition:=pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'Inventory reader guard insertion point missing';end if;
 definition:=replace(definition,marker,
 ' if p_scope=''management'' and not coalesce(app.current_role() in (''admin'',''purchaser''),false) then raise exception ''管理機能の在庫を閲覧する権限がありません'' using errcode=''42501'';end if;'
 ||chr(10)||marker);
 execute definition;
end $guard$;
