-- Return processing has no selling-duration value. Keep all business dates intact.
do $migration$
declare original text;patched text;
begin
 select pg_get_viewdef('app.v_items'::regclass,true) into original;
 patched:=replace(original,'i.sold_on - i.purchased_at AS days_to_sell',
  $replacement$CASE WHEN i.status<>'返品処理' THEN i.sold_on-i.purchased_at END AS days_to_sell$replacement$);
 patched:=replace(patched,'WHEN i.sold_on IS NULL THEN CURRENT_DATE - i.purchased_at',
  $replacement$WHEN i.sold_on IS NULL AND i.status<>'返品処理' THEN CURRENT_DATE-i.purchased_at$replacement$);
 if patched=original then raise exception 'Inventory duration definition changed';end if;
 execute 'create or replace view app.v_items with(security_invoker=true) as '||patched;
 select pg_get_viewdef('app.v_monthly_summary'::regclass,true) into original;
 patched:=replace(original,'avg(items.sold_on - items.purchased_at)',
  $replacement$avg(case when not exists(select 1 from app.items returned_item where returned_item.id=items.id and returned_item.status='返品処理') then items.sold_on-items.purchased_at end)$replacement$);
 if patched=original then raise exception 'Monthly duration definition changed';end if;
 execute 'create or replace view app.v_monthly_summary as '||patched;
 select pg_get_viewdef('app.v_product_performance'::regclass,true) into original;
 patched:=replace(original,'avg(i.sold_on - i.purchased_at)',
  $replacement$avg(case when i.status<>'返品処理' then i.sold_on-i.purchased_at end)$replacement$);
 if patched=original then raise exception 'Product duration definition changed';end if;
 execute 'create or replace view app.v_product_performance as '||patched;
end $migration$;
