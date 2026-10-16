-- Keep reviewed listing/shipping choices when the operator opens the panel again.
-- Invoker security and all existing row policies remain in force.
create index if not exists seller_history_by_item on app.seller_operations(item_id,created_at desc);
create or replace function app.seller_operation_context(p_item_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog,app as $$
 select jsonb_build_object(
 'listing',(select to_jsonb(l) from app.seller_listings l where l.item_id=i.id and l.active),
 'assignee',(select name from app.staff where id=i.deliverer_id),
 'shipping_defaults',(
   select jsonb_strip_nulls(jsonb_build_object('shippingMethod',s.p->'shippingMethod','size',s.p->'size','weightKg',s.p->'weightKg','dropoff',s.p->'dropoff','category',s.p->'category'))
   from app.seller_listings l cross join lateral (
     select coalesce((select o.payload from app.seller_operations o where o.item_id=i.id and o.channel=l.channel and o.account_id=l.account_id and o.kind='listing' and o.status='succeeded' and o.result->>'external_id'=l.external_id order by o.created_at desc limit 1),'{}'::jsonb)
       || coalesce((select o.payload from app.seller_operations o where o.item_id=i.id and o.channel=l.channel and o.account_id=l.account_id and o.kind in ('shipping_code','register_package') and o.status='succeeded' and o.payload->>'trade_key'=l.trade_key order by o.created_at desc limit 1),'{}'::jsonb) p
   ) s where l.item_id=i.id and l.active
 ),
 'revision',i.updated_at,
 'operations',coalesce((select jsonb_agg((to_jsonb(q)-'payload')||jsonb_build_object('trade_key',q.payload->>'trade_key','result',case when q.status='succeeded' and q.id=(select o.id from app.seller_operations o where o.item_id=i.id and o.kind=q.kind and o.status='succeeded' order by o.created_at desc limit 1) then q.result else jsonb_build_object('note',q.result->>'note') end) order by q.created_at desc) from (select * from app.seller_operations where item_id=i.id order by created_at desc limit 12) q),'[]'::jsonb))
 from app.items i where i.id=p_item_id
$$;
