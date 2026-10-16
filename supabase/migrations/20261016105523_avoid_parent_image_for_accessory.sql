-- Shared workflow/sales identity does not make a main item's image an accessory image.
-- Keep each view's columns, grants, RLS/security options and unrelated calculations intact.
do $migration$
declare target record; definition text; original text; replacement text; row_alias text;
begin
 for target in select * from (values
  ('v_inventory_display','product','raw'),
  ('v_delivery_tasks','p','i_1')
 ) as t(view_name,product_alias,item_alias)
 loop
  definition:=pg_get_viewdef(format('app.%I',target.view_name)::regclass,true);
  row_alias:=target.item_alias;
  if target.view_name='v_delivery_tasks' and position('i_1.product_id' in definition)=0 then row_alias:='i';end if;
  original:=format('COALESCE(NULLIF(btrim(%s.image_url), ''''::text), NULLIF(btrim(asin_product.image_url), ''''::text))',target.product_alias);
  replacement:=format($image$
   COALESCE(
    CASE WHEN NOT EXISTS (
     SELECT 1 FROM app.items image_parent
     WHERE %1$s.is_accessory AND image_parent.id=%1$s.parent_item_id
       AND image_parent.product_id=%1$s.product_id
    ) THEN NULLIF(btrim(%2$s.image_url), '') END,
    CASE WHEN NOT EXISTS (
     SELECT 1 FROM app.items image_parent
     WHERE %1$s.is_accessory AND image_parent.id=%1$s.parent_item_id
       AND image_parent.asin=%1$s.asin
    ) THEN NULLIF(btrim(asin_product.image_url), '') END
   )
  $image$,row_alias,target.product_alias);
  if position(original in definition)=0 then raise exception 'Expected image expression changed in %',target.view_name;end if;
  execute format('CREATE OR REPLACE VIEW app.%I AS %s',target.view_name,replace(definition,original,replacement));
 end loop;
end $migration$;
notify pgrst,'reload schema';
