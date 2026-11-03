-- Preserve current function bodies, grants and existing authorization/media guards.
do $migration$
declare signature text; body text;
begin
 foreach signature in array array[
  'app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb)',
  'app.remember_line_shipping_size(uuid)',
  'app.extension_prepare_line_shipping(text[])',
  'app.queue_packed_shipping_code(uuid)'
 ] loop
  -- The packed-photo auto-queue is present on some installations only.
  if to_regprocedure(signature) is null then
   if signature='app.queue_packed_shipping_code(uuid)' then continue;end if;
   raise exception 'Missing shipping function: %',signature;
  end if;
  body:=pg_get_functiondef(to_regprocedure(signature));
  if (length(body)-length(replace(body,'''宅急便コンパクト''','')))/length('''宅急便コンパクト''')<>1 then
   raise exception 'Shipping size guard changed: %',signature;
  end if;
  body:=replace(body,'''宅急便コンパクト''','''ネコポス'',''宅急便コンパクト''');
  if signature like 'app.save_line_shipping_preferences%' then
   if strpos(body,'if p_shipping ? ''size''')=0 then raise exception 'Missing preferences size guard';end if;
   body:=replace(body,'if p_shipping ? ''size''',
    'if p_shipping->>''size''=''ネコポス'' and p_shipping->>''shippingMethod'' is distinct from ''らくらくメルカリ便'' then raise exception ''ネコポスはらくらくメルカリ便を選択してください'';end if; if p_shipping ? ''size''');
  elsif signature like 'app.extension_prepare_line_shipping%' or signature like 'app.queue_packed_shipping_code%' then
   if strpos(body,'if coalesce(settings->>''size'','''') not in')=0 then raise exception 'Missing automatic shipping size guard: %',signature;end if;
   body:=replace(body,'if coalesce(settings->>''size'','''') not in',
    'if (settings->>''size''=''ネコポス'' and settings->>''shippingMethod'' is distinct from ''らくらくメルカリ便'') or coalesce(settings->>''size'','''') not in');
  end if;
  execute body;
 end loop;
end $migration$;

alter table app.delivery_line_size_history drop constraint delivery_line_size_history_size_check;
alter table app.delivery_line_size_history add constraint delivery_line_size_history_size_check
 check(size in ('100','140','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'));
