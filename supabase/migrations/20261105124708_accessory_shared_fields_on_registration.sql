-- Updates already share these sale fields. Also inherit them when an accessory
-- is registered after its body has been inspected, shipped or sold. Purchase
-- identity (including supplier, order, tracking and cost) remains independent.
create function app.inherit_accessory_shared_fields_on_insert() returns trigger
language plpgsql security definer set search_path='' as $$
declare parent app.items;
begin
 if not new.is_accessory or new.parent_item_id is null
  or app.is_standalone_accessory_serial(new.sku,new.lot_seq) then return new;end if;
 select * into parent from app.items where id=new.parent_item_id and not is_accessory for update;
 if parent.id is null then return new;end if;
 new.condition:=parent.condition;
 new.shipped_on:=parent.shipped_on;
 new.sold_on:=parent.sold_on;
 return new;
end $$;
revoke all on function app.inherit_accessory_shared_fields_on_insert() from public,anon,authenticated;
-- After items_link_accessory_parent_on_insert, before items_mark_sold/status.
create trigger items_lz_inherit_accessory_shared_fields
before insert on app.items for each row execute function app.inherit_accessory_shared_fields_on_insert();

-- Existing dates are already synchronized. Correct only old condition drift,
-- without redirecting an accessory's historical fields back into its body.
-- The lock and trigger toggle are transactional; normal writes cannot overlap.
lock table app.items in share row exclusive mode;
do $$declare baseline text;afterwards text;begin
 select md5(coalesce(string_agg((to_jsonb(i)-array['condition','updated_at'])::text,'' order by id),''))
 into baseline from app.items i;
 alter table app.items disable trigger items_redirect_accessory_shared_edits;
 with parents as (
  select a.id,(array_agg(p.id))[1] parent_id from app.items a join app.items p
   on not p.is_accessory and (p.id=a.parent_item_id or (a.parent_item_id is null and p.lot_seq=a.lot_seq
    and app.product_serial(p.sku,p.lot_seq)=app.product_serial(a.sku,a.lot_seq)))
  where a.is_accessory and not app.is_standalone_accessory_serial(a.sku,a.lot_seq)
  group by a.id having count(*)=1
 )
 update app.items a set condition=p.condition from parents x join app.items p on p.id=x.parent_id
 where a.id=x.id and a.condition is distinct from p.condition;
 alter table app.items enable trigger items_redirect_accessory_shared_edits;
 select md5(coalesce(string_agg((to_jsonb(i)-array['condition','updated_at'])::text,'' order by id),''))
 into afterwards from app.items i;
 if baseline is distinct from afterwards then raise exception 'Accessory condition repair changed unrelated item data';end if;
end $$;
notify pgrst,'reload schema';
