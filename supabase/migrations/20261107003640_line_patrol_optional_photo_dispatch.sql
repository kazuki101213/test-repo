-- The four-hour patrol must hand off ready notifications even when no photos
-- were explicitly selected. Code preparation uses shipping settings, not photos.
do $migration$
declare source text;patched text;begin
 source:=pg_get_functiondef('app.extension_prepare_line_shipping(text[])'::regprocedure);
 patched:=replace(source,
  'and exists(select 1 from app.delivery_line_preferences pref where pref.item_id=item.id and pref.overview_photo_id is not null and pref.model_photo_id is not null)',
  '');
 if patched=source then raise exception 'LINE patrol photo filter anchor changed';end if;
 source:=patched;
 patched:=replace(source,
  'if app.line_shipping_media(o.id)->>''codeOperationId'' is not null then continue;end if;',
  'if app.line_shipping_media(o.id) is not null then update app.delivery_line_outbox set last_error=null where id=o.id;continue;end if;');
 if patched=source then raise exception 'LINE patrol ready handoff anchor changed';end if;
 source:=patched;
 patched:=replace(source,
  'if not exists(select 1 from app.delivery_line_preferences where item_id=i.id and overview_photo_id is not null and model_photo_id is not null) then reason:=''通知写真を指定してください'';end if;',
  '');
 if patched=source then raise exception 'LINE patrol photo requirement anchor changed';end if;
 execute patched;
end $migration$;

-- Keep the existing authenticated-admin gate, current-trade checks, shipping
-- configuration validation and retry keys. No new schedule or public access.
notify pgrst,'reload schema';
