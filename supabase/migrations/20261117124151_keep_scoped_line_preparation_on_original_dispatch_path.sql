-- A targeted code preparation wakes LINE only through the normal code-completion trigger.
do $migration$
declare
 source text := pg_get_functiondef('app.extension_prepare_line_shipping(text[],uuid,text)'::regprocedure);
 old_wake text := ' perform app.kick_delivery_line();';
 new_wake text := ' if p_item_id is null then perform app.kick_delivery_line(); end if;';
begin
 if strpos(source,new_wake)>0 then return; end if;
 if strpos(source,old_wake)=0 then raise exception 'Expected LINE kick not found'; end if;
 execute replace(source,old_wake,new_wake);
end;
$migration$;
