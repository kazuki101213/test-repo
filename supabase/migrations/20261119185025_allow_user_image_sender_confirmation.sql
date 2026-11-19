do $migration$
declare
  definition text;
  old text := 'p_account_label not in (''ヤフオク1'', ''ヤフオク2'')';
  new text := 'p_account_label not in (''ヤフオク1'', ''ヤフオク2'', ''利用者提供画像'')';
begin
  definition := pg_get_functiondef('app.record_untracked_shipping_sender(text,text,text,text,text)'::regprocedure);
  if strpos(definition, old) = 0 then
    if strpos(definition, new) > 0 then return; end if;
    raise exception 'sender RPC account-label validation anchor is missing';
  end if;
  execute replace(definition, old, new);
end
$migration$;

comment on function app.record_untracked_shipping_sender(text,text,text,text,text)
  is 'Admin-only. For Yahoo Auctions standard mail, stores seller name and prefecture/city in dedicated fields. p_account_label is a registered Yahoo account label or 利用者提供画像 when manually verified from a user-provided image.';
