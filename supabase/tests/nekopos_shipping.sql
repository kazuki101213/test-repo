begin;
select set_config('request.jwt.claim.sub',(select p.user_id::text from app.profiles p join app.staff s on s.id=p.staff_id where s.code='AA' limit 1),true);
update app.delivery_line_settings set enabled=false;
insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,asin)
values(998779,(select id from app.staff where code='AA'),(select id from app.staff where code='DD'),current_date,'DC04PRO',900,'ヤフオク','メルカリ','B0NEKO0001');

set local role authenticated;
do $$declare item uuid; failed boolean;begin
 select id into item from app.items where lot_seq=998779;
 perform app.save_line_shipping_preferences(item,null,null,'{"shippingMethod":"らくらくメルカリ便","size":"ネコポス","dropoff":"セブンイレブン","category":"小物"}');
 if (select shipping->>'size' from app.delivery_line_preferences where item_id=item) is distinct from 'ネコポス' then raise exception 'Nekopos was not saved';end if;
 failed:=false;
 begin
  perform app.save_line_shipping_preferences(item,null,null,'{"shippingMethod":"ゆうゆうメルカリ便","size":"ネコポス","dropoff":"郵便局"}');
 exception when raise_exception then failed:=true;end;
 if not failed then raise exception 'Postal Nekopos was accepted';end if;
 if (select shipping->>'shippingMethod' from app.delivery_line_preferences where item_id=item) is distinct from 'らくらくメルカリ便' then raise exception 'Invalid attempt changed saved settings';end if;
end $$;
reset role;
update app.items set shipped_on=current_date where lot_seq=998779;
select app.remember_line_shipping_size(id) from app.items where lot_seq=998779;
do $$begin
 if (select size from app.delivery_line_size_history where product_key='asin:B0NEKO0001') is distinct from 'ネコポス' then raise exception 'Nekopos shipment was not remembered';end if;
 if exists(select 1 from app.seller_operations where item_id=(select id from app.items where lot_seq=998779)) then raise exception 'Preferences unexpectedly queued a shipping operation';end if;
end $$;
rollback;
