-- Keep the reply entry available after notice acknowledgement, but only for an actual reply.
-- Reuse the notice definition: an admin/purchaser comment after the latest malfunction report.
do $$declare definition text;begin
 definition:=regexp_replace(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),';\s*$','');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as
 select v.*,exists(
  select 1 from app.item_comments c join app.staff s on s.id=c.author_id
  where c.item_id=v.id and c.created_at>v.malfunction_reported_at
   and s.role in (''admin'',''purchaser'')
 ) as has_malfunction_reply from ('||definition||') v';
end $$;
notify pgrst,'reload schema';
