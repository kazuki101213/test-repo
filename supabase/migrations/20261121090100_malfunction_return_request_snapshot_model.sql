-- 「返送お願いします。」のカードにも、動作確認と同じく型番・商品名を付ける。
do $patch$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  old_join constant text := $o$t.kind in ('inspection','shipping')$o$;
  new_join constant text := $n$t.kind in ('inspection','shipping','return_request')$n$;
  old_case constant text := $o$when 'shipping' then jsonb_build_object('sales_channel'$o$;
  new_case constant text := $n$when 'return_request' then jsonb_build_object('model_no',p.model_no,'title',i.title)
      when 'shipping' then jsonb_build_object('sales_channel'$n$;
  old_product constant text := $o$p on t.kind='inspection' and$o$;
  new_product constant text := $n$p on t.kind in ('inspection','return_request') and$n$;
begin
  if strpos(definition, old_join)=0 or strpos(definition, old_case)=0 or strpos(definition, old_product)=0
     or strpos(definition, 'return_request')>0 then
    raise exception 'delivery_work_tasks snapshot changed unexpectedly';
  end if;
  execute replace(replace(replace(definition, old_join, new_join), old_case, new_case), old_product, new_product);
end
$patch$;
notify pgrst, 'reload schema';
