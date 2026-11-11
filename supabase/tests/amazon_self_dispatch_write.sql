begin;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,asin,condition,cost_amount,marketplace,sales_channel,status,inspected_at,product_registered_at)
select 998677,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),
 current_date-10,'Amazon dispatch fixture','B000000002','非常に良い',100,'ヤフオク','自己発送2','出品中',now(),now();
update app.items set status='取引中' where lot_seq=998677;

do $$
declare
  item app.items%rowtype;
begin
  select * into item from app.items where lot_seq=998677;
  set local role service_role;
  if app.apply_amazon_self_dispatch(item.id,'amazon-1',item.sku,item.asin,item.status,item.updated_at,current_date-1) then
    raise exception 'Mismatched Amazon account wrote a date';
  end if;
  if app.apply_amazon_self_dispatch(item.id,'amazon-2',item.sku,item.asin,item.status,item.updated_at-interval '1 minute',current_date-1) then
    raise exception 'Stale inventory revision wrote a date';
  end if;
  if not app.apply_amazon_self_dispatch(item.id,'amazon-2',item.sku,item.asin,item.status,item.updated_at,current_date-1) then
    raise exception 'Service could not save a verified dispatch date';
  end if;
  reset role;
  select * into item from app.items where lot_seq=998677;
  if item.shipped_on is distinct from current_date-1 then raise exception 'Dispatch date not saved'; end if;
  set local role service_role;
  if app.apply_amazon_self_dispatch(item.id,'amazon-2',item.sku,item.asin,item.status,item.updated_at,current_date) then
    raise exception 'Existing date was overwritten';
  end if;
  reset role;
  if has_function_privilege('authenticated','app.apply_amazon_self_dispatch(uuid,text,text,text,app.item_status,timestamptz,date)','EXECUTE') then
    raise exception 'Inventory dispatch write granted to regular users';
  end if;
end;
$$;
rollback;
