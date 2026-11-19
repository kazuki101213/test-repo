do $migration$
declare
  definition text;
  old text := 'if auth.uid() is null or not app.is_admin() then';
  new text := 'if current_user <> ''postgres'' and (auth.uid() is null or not app.is_admin()) then';
begin
  definition := pg_get_functiondef('app.record_untracked_shipping_sender(text,text,text,text,text)'::regprocedure);
  if strpos(definition, old) = 0 then
    if strpos(definition, new) > 0 then return; end if;
    raise exception 'sender RPC authorization anchor is missing';
  end if;
  execute replace(definition, old, new);
end
$migration$;
