begin;
do $$
declare item app.items%rowtype; result app.items%rowtype; user_aa uuid;
begin
  select * into strict item from app.items where lot_seq=2102 and not is_accessory;
  select p.user_id into strict user_aa from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA';
  perform set_config('request.jwt.claim.sub',user_aa::text,true);
  set local role authenticated;
  update app.items set status='返品処理',sold_on=sold_on,returned_on=returned_on where id=item.id;
  update app.items set status='販売済',sold_on=sold_on,returned_on=returned_on where id=item.id;
  select * into strict result from app.items where id=item.id;
  if result.status<>'販売済' or result.returned_on is distinct from item.returned_on
    or result.sold_on is distinct from item.sold_on or result.sold_price is distinct from item.sold_price
    or result.payout_amount is distinct from item.payout_amount then raise exception 'Manual override changed saved history'; end if;
  update app.items set sold_on=sold_on,returned_on=returned_on where id=item.id;
  if (select status from app.items where id=item.id)<>'販売済' then raise exception 'Repeated full save reverted status'; end if;
  update app.items set returned_on=item.returned_on+1 where id=item.id;
  if (select status from app.items where id=item.id)<>'返品処理' then raise exception 'New return no longer triggers processing'; end if;
end $$;
select 'Authenticated manual sale, repeat save and new return passed' as result;
rollback;
