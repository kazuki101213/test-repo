-- Restrict the manual settings panel and operations to active administrators.
-- The background LINE jobs and the shipping defaults used by staff have separate entry points.
do $migration$
declare
  signature regprocedure;
  definition text;
  old_access text := 'not (app.is_admin() or i.deliverer_id=app.current_staff_id())';
begin
  foreach signature in array array[
    'app.line_shipping_context(uuid)'::regprocedure,
    'app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb)'::regprocedure,
    'app.request_delivery_line_resend(uuid)'::regprocedure
  ] loop
    definition := pg_get_functiondef(signature);
    if strpos(definition, old_access) = 0 then
      raise exception 'LINE shipping access check changed for %', signature;
    end if;
    definition := replace(definition, old_access, 'not app.is_admin()');
    definition := replace(definition, '担当商品のみ確認できます', '管理者のみLINE発送設定を確認できます');
    definition := replace(definition, '担当商品のみ設定できます', '管理者のみLINE発送設定を保存できます');
    definition := replace(definition, '担当商品のみ再送できます', '管理者のみLINEを再送できます');
    execute definition;
  end loop;
end;
$migration$;
