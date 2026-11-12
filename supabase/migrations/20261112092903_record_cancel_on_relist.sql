-- Keep the operator's cancellation record separate from observations made on the marketplace.
alter table app.seller_listings
  add column relist_event_id uuid references app.inventory_workflow_events(id);
create unique index seller_listings_relist_event_idx
  on app.seller_listings(relist_event_id) where relist_event_id is not null;

do $migration$
declare
  definition text;
  updated text;
  event_insert constant text := $anchor$ insert into app.inventory_workflow_events(id,item_id,actor_id,action,from_status,to_status,note) values(p_request_id,i.id,actor,p_action,i.status,target,nullif(btrim(p_note),''));$anchor$;
  listing_match constant text := $anchor$ if l.id is not null and l.item_id<>i.id then return 'unmatched';end if;$anchor$;
begin
  definition := pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
  updated := replace(definition, event_insert, event_insert || $body$
 if p_action='resell' then
  update app.seller_listings set active=false,relist_event_id=p_request_id
   where item_id=i.id and channel=i.sales_channel and active and verified_sale is null;
 end if;$body$);
  if updated = definition then raise exception 'Inventory workflow history insert not found'; end if;
  execute updated;

  definition := pg_get_functiondef('app.sync_seller_observation(text,jsonb)'::regprocedure);
  updated := replace(definition, listing_match, listing_match || $body$
 if l.relist_event_id is not null then
  -- A late marketplace confirmation can update the old link only.
  if state='キャンセル' and trade is not null and trade=l.trade_key
    and (l.observed_at is null or observed>l.observed_at) then
   update app.seller_listings set observed_status=state,observed_at=observed where id=l.id;
   return 'updated';
  end if;
  return 'protected';
 end if;$body$);
  if updated = definition then raise exception 'Seller observation listing lookup not found'; end if;
  execute updated;
end $migration$;

notify pgrst, 'reload schema';
