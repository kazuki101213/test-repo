-- Make the product master the editable source of shipping category and size.
alter table app.products
  add column if not exists shipping_category text,
  add column if not exists shipping_size text;

alter table app.products drop constraint if exists products_shipping_category_check;
alter table app.products add constraint products_shipping_category_check
  check (shipping_category is null or shipping_category in ('モ','ブ','小'));
alter table app.products drop constraint if exists products_shipping_size_check;
alter table app.products add constraint products_shipping_size_check
  check (shipping_size is null or shipping_size in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'));

-- Carry forward the existing model defaults into product-list data.
update app.products p
set shipping_size=app.line_model_shipping_size(p.model_no,null)
where p.shipping_size is null and nullif(btrim(p.model_no),'') is not null;
update app.products p
set shipping_category=case when p.shipping_size='140' then 'モ' when p.shipping_size='100' then 'ブ' else '小' end
where p.shipping_category is null;

create or replace function app.line_model_shipping_size(p_model text,p_title text) returns text
language sql stable set search_path='' as $$
  select p.shipping_size
  from app.products p
  where nullif(btrim(p.model_no),'') is not null
    and (
      upper(btrim(p.model_no))=upper(btrim(coalesce(p_model,'')))
      or (nullif(btrim(p_model),'') is null and strpos(upper(coalesce(p_title,'')),upper(btrim(p.model_no)))>0)
    )
  order by (upper(btrim(p.model_no))=upper(btrim(coalesce(p_model,'')))) desc,length(p.model_no) desc
  limit 1;
$$;

create or replace function app.line_fixed_shipping_size(p_item_id uuid) returns text
language sql stable set search_path='' as $$
  select p.shipping_size
  from app.items i
  join app.products p on p.id=i.product_id or (i.product_id is null and nullif(i.asin,'') is not null and p.asin=i.asin)
  where i.id=p_item_id and (not i.is_accessory or p.shipping_category='小')
  order by (p.id=i.product_id) desc
  limit 1;
$$;

revoke all on function app.line_model_shipping_size(text,text),app.line_fixed_shipping_size(uuid) from public,anon;
grant execute on function app.line_model_shipping_size(text,text),app.line_fixed_shipping_size(uuid) to authenticated,service_role;

-- Allow the standard carrier size ladder in per-item settings and remembered history.
do $migration$
declare signature text; body text; old_prefix text; new_prefix text;
begin
  old_prefix := '''100'',''140'',''ネコポス''';
  new_prefix := '''60'',''80'',''100'',''120'',''140'',''160'',''180'',''200'',''ネコポス''';
  foreach signature in array array[
    'app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb)',
    'app.remember_line_shipping_size(uuid)',
    'app.extension_prepare_line_shipping(text[])',
    'app.queue_packed_shipping_code(uuid)'
  ] loop
    if to_regprocedure(signature) is null then
      if signature='app.queue_packed_shipping_code(uuid)' then continue; end if;
      raise exception 'Missing shipping function: %',signature;
    end if;
    body:=pg_get_functiondef(to_regprocedure(signature));
    if strpos(body,old_prefix)=0 then
      if strpos(body,new_prefix)>0 then continue; end if;
      raise exception 'Shipping size list changed unexpectedly: %',signature;
    end if;
    body:=replace(body,old_prefix,new_prefix);
    execute body;
  end loop;
end $migration$;

alter table app.delivery_line_size_history drop constraint if exists delivery_line_size_history_size_check;
alter table app.delivery_line_size_history add constraint delivery_line_size_history_size_check
  check(size in ('60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'));
